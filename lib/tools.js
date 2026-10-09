/**
 * dsh-verified-progress — the model-facing tools.
 *
 * Three tools, one loop:
 *
 *   verify  — certify one claim; writes a round to the ledger, and only a clean
 *             verdict is recorded as progress;
 *   ledger  — read back the rounds, so a fresh or compacted context can see what
 *             is actually done rather than what was claimed;
 *   state   — the short projection: verified rounds, rejected claims, open items.
 *
 * `verify` is the only writer. Everything the executor claims has to pass
 * through it to become progress, which is what makes the ledger trustworthy.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

import { appendEvent, appendRound, readLedger } from "./core/ledger.js";
import {
  HARNESS_HOME_EXCLUDED_ROOTS,
  describeDiff,
  diffSnapshots,
  snapshotWorkspace,
} from "./core/guard.js";
import { enforceVerdict, parseVerdict } from "./core/verdict.js";
import { runContext, stateRoot } from "./state.js";
import { buildVerifierPrompt, runVerificationEpisode } from "./verifier.js";
import path from "node:path";

const text = (value) => [{ type: "text", text: value }];

/**
 * Decide what the mutation guard is allowed to judge.
 *
 * The guard originally fingerprinted the whole workspace root, which is wrong
 * whenever that root is `~/.dsh`: the harness writes its session log,
 * projection caches and plugin state continuously, so every verification was
 * reported as `integrity: violation`. That is a false accusation — the
 * fingerprint could not tell the verifier's writes from the session's own — and
 * a guard that fires on the host's writes downgrades every round while looking
 * like a conservative verdict.
 *
 * So the scope is declared, not assumed:
 *  - `scope` names a workspace-relative directory or a glob; its non-glob
 *    prefix becomes the snapshot root;
 *  - the scope must resolve **inside** the workspace, which keeps the guard
 *    meaningful even when the scope is model-supplied;
 *  - when the workspace is the harness home, harness-owned paths are excluded
 *    and naming a scope is mandatory, because "everything under here" is not a
 *    boundary anyone can reason about.
 *
 * @param {{ workspace: string, scope?: string }} args
 * @returns {Promise<{root: string, excludeRoots: string[], note: string}>}
 */
export async function resolveGuardScope({ workspace, scope }) {
  const workspaceResolved = path.resolve(workspace);
  const isHarnessHome =
    workspaceResolved === path.resolve(stateRoot()) ||
    workspaceResolved.split(path.sep).join("/").endsWith("/.dsh");

  if (typeof scope !== "string" || scope.trim() === "") {
    if (isHarnessHome) {
      throw new Error(
        "guard_scope is required when the session's working directory is the harness home: " +
          "the harness writes its own session logs and caches there, so a whole-tree fingerprint " +
          "would report the verifier as having mutated the workspace. Pass the workspace-relative " +
          "path or glob the claim is actually about, for example 'projects/my-app/**'.",
      );
    }
    return { root: workspaceResolved, excludeRoots: [], note: `${workspaceResolved} (workspace root)` };
  }

  const normalized = scope.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`guard_scope must be a workspace-relative path without '..': ${scope}`);
  }

  const globAt = normalized.search(/[*?[{]/);
  const prefix = globAt === -1 ? normalized : normalized.slice(0, globAt);
  const root = path.resolve(workspaceResolved, prefix.replace(/\/+$/, ""));

  const relative = path.relative(workspaceResolved, root);
  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(`guard_scope escapes the workspace: ${scope}`);
  }

  const excludeRoots = isHarnessHome && relative === "" ? [...HARNESS_HOME_EXCLUDED_ROOTS] : [];
  return {
    root,
    excludeRoots,
    note: excludeRoots.length > 0 ? `${root} (harness home: own state excluded)` : root,
  };
}

const JSON_OBJECT = { type: "object", additionalProperties: true };

const STATUS_SCHEMA = {
  type: "string",
  enum: ["complete", "incomplete", "blocked"],
  required: true,
  description: "The enforced verdict. Only `complete` is recorded as progress.",
};

const INTEGRITY_SCHEMA = {
  type: "string",
  enum: ["clean", "suspect", "violation"],
  required: true,
  description: "Whether the inspected work is genuine.",
};

const CONTRACT_SCHEMA = {
  type: "string",
  enum: ["aligned", "unknown", "needs_revision", "invalid"],
  required: true,
  description: "Whether the delivered work matches the stated acceptance criteria.",
};

function strings() {
  return { type: "array", items: { type: "string" } };
}

/**
 * Compose the model-facing summary of one verification.
 */
function summarize({ verdict, diff, verifierError, round, scope }) {
  const lines = [];
  lines.push(`Round ${round}: ${verdict.status.toUpperCase()} (integrity: ${verdict.integrity}, contract: ${verdict.contract})`);

  if (verdict.evidenceOnly) {
    lines.push(
      "Recorded as EVIDENCE ONLY — this claim is not progress and must not be counted as done.",
    );
  } else {
    lines.push("Recorded as VERIFIED PROGRESS.");
  }
  if (verdict.downgraded) {
    lines.push(`Downgraded: ${verdict.downgradeReasons.join("; ")}`);
  }
  lines.push(`Fingerprinted: ${scope}`);
  lines.push(`Workspace: ${describeDiff(diff)}`);
  if (diff.evidenceGaps.length > 0) {
    lines.push(`Evidence gaps: ${diff.evidenceGaps.join("; ")}`);
  }
  if (verifierError) {
    lines.push(`Verifier episode failed: ${verifierError}`);
  }
  return lines.join("\n");
}

/**
 * @param {object} ctx cordis plugin context
 * @param {{ stateDir?: string }} [options]
 */
export function registerTools(ctx, options = {}) {
  const disposers = [];

  const contextFor = (exec) => {
    const agent = exec.agent;
    if (agent === undefined) {
      throw new Error("verified-progress tools require a live DSH agent");
    }
    return { agent, ...runContext({ stateDir: options.stateDir, agent }) };
  };

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "verified_progress_verify",
        description:
          "Verify one claimed step against the real workspace using an independent verifier with a fresh context, then record the verdict in the verified-progress ledger. Use this before reporting any substantial step as done: only a clean, aligned, complete verdict is recorded as progress, and anything else is kept as evidence. The verifier reads files; it cannot write, and the declared scope is fingerprinted before and after it runs so a verifier that changes anything is caught.",
        parameters: {
          claim: {
            type: "string",
            required: true,
            description: "The single claim to verify, phrased as something the workspace can confirm or contradict.",
          },
          guard_scope: {
            type: "string",
            description:
              "Workspace-relative path or glob for this claim ('src/**', 'report.md'). Only this scope is fingerprinted, so a concurrently running session cannot be mistaken for the verifier. Required when the session's working directory is the harness home itself.",
          },
          acceptance: {
            type: "string",
            description: "The criteria the claim is judged against. Omit to let the verifier infer them from the claim.",
          },
          evidence_hint: {
            type: "string",
            description: "Paths or checks the claimant believes prove it. Treated as a pointer, never as evidence.",
          },
          note: {
            type: "string",
            description: "Short label for this round, shown in the ledger.",
          },
        },
        output: {
          // Value-schema DSL. An object node REQUIRES an explicit
          // `additionalProperties` and every field that must survive to the
          // model has to be declared: a declared field that is missing from the
          // canonical value is dropped rather than passed through, and an
          // undeclared field never reaches the caller at all. (A first version
          // declared `additionalProperties: true` with no properties, which
          // silently swallowed everything the tool returned.)
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              round: { type: "integer", required: true },
              verdict: {
                type: "object",
                additionalProperties: false,
                required: true,
                properties: {
                  status: STATUS_SCHEMA,
                  integrity: INTEGRITY_SCHEMA,
                  contract: CONTRACT_SCHEMA,
                  evidence_only: {
                    type: "boolean",
                    required: true,
                    description: "True when the claim was rejected and is not progress.",
                  },
                  downgraded: { type: "boolean", required: true },
                  downgrade_reasons: strings(),
                  workspace_mutated: { type: "boolean", required: true },
                  changed_paths: strings(),
                  evidence_gaps: strings(),
                },
              },
              task_state: { type: "string", required: true },
              missing: strings(),
              evidence: strings(),
              verifier_provider: { type: "string", required: true },
              verifier_error: { type: "string" },
              scope: { type: "string", required: true, description: "What the fingerprint actually covered." },
              summary: { type: "string", required: true },
            },
          },
          render: (_args, value) => text(value.summary),
        },
        timeoutMs: 30 * 60 * 1000,
        execute: async (args, exec) => {
          const { agent, stateDir, workspace, runId } = contextFor(exec);

          // Read the ledger first: the round number must be reserved before the
          // verifier runs, so a concurrent call cannot claim the same index.
          const before = await readLedger({ stateDir, runId });
          const round = before.nextRound;

          // Resolve what the fingerprint is allowed to judge. See resolveGuardScope
          // for why this is not simply the workspace root.
          const scope = await resolveGuardScope({ workspace, scope: args.guard_scope });

          await appendEvent({
            stateDir,
            runId,
            event: "verify_started",
            data: { round, claim: args.claim, workspace, scope: scope.root, scopeNote: scope.note },
          });

          const snapshotBefore = await snapshotWorkspace(scope.root, { excludeRoots: scope.excludeRoots });

          const prompt = buildVerifierPrompt({
            claim: args.claim,
            acceptance: args.acceptance,
            evidenceHint: args.evidence_hint,
            workspace,
          });

          const episode = await runVerificationEpisode({
            subagents: ctx.subagents,
            parent: agent,
            signal: exec.signal,
            prompt,
          });

          const snapshotAfter = await snapshotWorkspace(scope.root, { excludeRoots: scope.excludeRoots });
          const diff = diffSnapshots(snapshotBefore, snapshotAfter);

          const parsed = episode.status === "ok" ? parseVerdict(episode.text) : parseVerdict("");
          const verdict = enforceVerdict(parsed, {
            verifierMutatedWorkspace: diff.mutated,
            changedPaths: [...diff.added, ...diff.changed],
          });

          const verifierText = episode.status === "ok" ? episode.text : "";
          const record = {
            round,
            claim: args.claim,
            note: args.note ?? "",
            acceptance: args.acceptance ?? "",
            verdict: verdict.status,
            integrity: verdict.integrity,
            contract: verdict.contract,
            downgraded: verdict.downgraded,
            downgradeReasons: verdict.downgradeReasons,
            evidence: extractSection(verifierText, "evidence"),
            missing: extractSection(verifierText, "missing"),
            taskState: extractSectionText(verifierText, "task state"),
            changedPaths: [...diff.added, ...diff.changed, ...diff.removed],
            evidenceGaps: diff.evidenceGaps,
            verifierProvider: episode.provider ?? "none",
            verifierError: episode.status === "ok" ? "" : episode.reason,
            workspaceMutated: diff.mutated,
            guardScope: scope.note,
          };

          await appendRound({ stateDir, runId, round: record });

          const summary = summarize({
            verdict,
            diff,
            verifierError: record.verifierError,
            round,
            scope: scope.note,
          });

          return {
            round,
            verdict: {
              status: verdict.status,
              integrity: verdict.integrity,
              contract: verdict.contract,
              evidence_only: verdict.evidenceOnly,
              downgraded: verdict.downgraded,
              downgrade_reasons: verdict.downgradeReasons,
              workspace_mutated: diff.mutated,
              changed_paths: record.changedPaths,
              evidence_gaps: diff.evidenceGaps,
            },
            task_state: record.taskState,
            missing: record.missing,
            evidence: record.evidence,
            verifier_provider: record.verifierProvider,
            ...(record.verifierError === "" ? {} : { verifier_error: record.verifierError }),
            scope: scope.note,
            summary,
          };
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "verified_progress_ledger",
        description:
          "Read the verified-progress ledger for the current run: which steps an independent verifier confirmed, which were rejected and why, and what remains. Use it to recover context after a compaction, a crash, or in a fresh session instead of trusting a summary written by the agent that did the work.",
        parameters: {
          limit: {
            type: "integer",
            description: "Maximum rounds to return, newest last. Defaults to all of them, capped at 50.",
          },
          include_rejected: {
            type: "boolean",
            description: "Include rounds whose claims were rejected. Defaults to true.",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              run_id: { type: "string", required: true },
              rounds: { type: "integer", required: true },
              verified_rounds: { type: "array", items: { type: "integer" }, required: true },
              rejected_rounds: { type: "array", items: { type: "integer" }, required: true },
              next_round: { type: "integer", required: true },
              task_state: { type: "string", required: true },
              open_items: strings(),
              warnings: strings(),
              entries: { type: "array", items: JSON_OBJECT, required: true },
              summary: { type: "string", required: true },
            },
          },
          render: (_args, value) => text(value.summary),
        },
        execute: async (args, exec) => {
          const { stateDir, runId } = contextFor(exec);
          const ledger = await readLedger({ stateDir, runId });
          const limit = Math.min(Math.max(args.limit ?? 50, 1), 50);
          const includeRejected = args.include_rejected ?? true;

          const considered = includeRejected
            ? ledger.rounds
            : ledger.rounds.filter((round) => round.verdict === "complete");
          const entries = considered.slice(-limit).map((round) => ({
            round: round.round,
            verdict: round.verdict,
            integrity: round.integrity,
            contract: round.contract,
            claim: round.claim,
            note: round.note ?? "",
            missing: round.missing ?? [],
            task_state: round.taskState ?? "",
          }));

          const state = ledger.verified.length > 0 ? ledger.verified[ledger.verified.length - 1] : undefined;
          const summary = [
            `Run ${runId}: ${ledger.verified.length} verified round(s), ${ledger.rejected.length} rejected.`,
            state?.taskState ? `Verified state: ${state.taskState}` : "Verified state: (nothing verified yet)",
            ledger.rejected.length > 0
              ? `Open (not progress): ${ledger.rejected.map((round) => `#${round.round} ${round.claim}`).join(" | ")}`
              : "",
            ledger.warnings.length > 0 ? `Ledger warnings: ${ledger.warnings.join("; ")}` : "",
          ]
            .filter((line) => line !== "")
            .join("\n");

          return {
            run_id: runId,
            rounds: ledger.rounds.length,
            verified_rounds: ledger.verified.map((round) => round.round),
            rejected_rounds: ledger.rejected.map((round) => round.round),
            next_round: ledger.nextRound,
            task_state: state?.taskState ?? "",
            open_items: state?.missing ?? [],
            warnings: ledger.warnings,
            entries,
            summary,
          };
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "verified_progress_state",
        description:
          "Show the current verified-progress state: verified rounds, rejected (evidence-only) claims, the maintained task state, and the items still open. Cheaper than reading the whole ledger.",
        parameters: {},
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              run_id: { type: "string", required: true },
              verified: { type: "integer", required: true },
              rejected: { type: "integer", required: true },
              task_state: { type: "string", required: true },
              open_items: strings(),
              pending_claims: { type: "array", items: JSON_OBJECT, required: true },
              summary: { type: "string", required: true },
            },
          },
          render: (_args, value) => text(value.summary),
        },
        execute: async (_args, exec) => {
          const { stateDir, runId } = contextFor(exec);
          const ledger = await readLedger({ stateDir, runId });
          const lastVerified = ledger.verified[ledger.verified.length - 1];
          const pending = ledger.rejected.map((round) => ({
            round: round.round,
            claim: round.claim,
            reasons: round.downgradeReasons ?? [],
          }));

          const summary = [
            `${ledger.verified.length} verified / ${ledger.rejected.length} rejected in run ${runId}.`,
            lastVerified?.taskState ? `State: ${lastVerified.taskState}` : "State: nothing verified yet.",
            pending.length > 0 ? `Unproven claims: ${pending.map((item) => `#${item.round} ${item.claim}`).join(" | ")}` : "",
          ]
            .filter((line) => line !== "")
            .join("\n");

          return {
            run_id: runId,
            verified: ledger.verified.length,
            rejected: ledger.rejected.length,
            task_state: lastVerified?.taskState ?? "",
            open_items: lastVerified?.missing ?? [],
            pending_claims: pending,
            summary,
          };
        },
      }),
    ),
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        // A disposer that throws must not prevent the remaining ones from running.
      }
    }
  };
}

/**
 * The section labels the verifier prompt asks for. Boundaries are matched
 * against this closed vocabulary rather than guessed from line shape, because
 * line shape does not work: an evidence bullet like
 * `- src/a.js:12 exports run()` starts at column 0 and contains a colon, so any
 * "looks like a heading" test truncates the Evidence section to nothing — which
 * is exactly what it did before this list existed.
 */
const SECTION_LABELS = [
  "evidence",
  "missing",
  "task state",
  "task_state",
  "taskstate",
  "notes",
  "verdict",
  "证据",
  "缺口",
  "任务状态",
  "缺失",
  "状态",
  "结论",
];

const SECTION_LABEL_RE = new RegExp(
  `^(?:[-*]\\s*)?(?:\\*\\*)?\\s*(?:${SECTION_LABELS.map(escapeRegExp).join("|")})\\s*[:：]`,
  "i",
);

/**
 * Pull one `Label:` section out of a verifier report as a list.
 *
 * The verifier writes free text; the control lines are the machine-readable
 * part and these sections are the human-readable part. Parsing them as lists
 * keeps the ledger useful without pretending they are structured data.
 */
export function extractSection(report, label) {
  const text = extractSectionText(report, label);
  if (text === "") return [];
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line !== "" && !isNone(line));
}

/** Same as {@link extractSection} but keeps the raw paragraph. */
export function extractSectionText(report, label) {
  if (typeof report !== "string" || report.trim() === "") return "";

  const wanted = new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?\\s*(${escapeRegExp(label)})\\s*[:：]\\s*(.*)$`,
    "i",
  );

  const lines = report.split("\n");
  let collecting = false;
  const collected = [];

  for (const line of lines) {
    const match = wanted.exec(line);
    if (match) {
      collecting = true;
      if (match[2].trim() !== "") collected.push(match[2].trim());
      continue;
    }
    if (!collecting) continue;
    // Any other known section heading ends this one.
    if (SECTION_LABEL_RE.test(line)) break;
    collected.push(line.trim());
  }

  const value = collected.join("\n").trim();
  return isNone(value) ? "" : value;
}

function isNone(value) {
  return /^(?:none|nothing|n\/?a|无|没有|暂无)\.?$/i.test(value.trim());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
