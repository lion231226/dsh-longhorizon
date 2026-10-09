/**
 * dsh-longhorizon — the model-facing tools.
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
import { describeDiff, diffSnapshots, snapshotWorkspace } from "./core/guard.js";
import { enforceVerdict, parseVerdict } from "./core/verdict.js";
import { runContext } from "./state.js";
import { buildVerifierPrompt, runVerificationEpisode } from "./verifier.js";

const text = (value) => [{ type: "text", text: value }];

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
function summarize({ verdict, diff, verifierError, round }) {
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
      throw new Error("longhorizon tools require a live DSH agent");
    }
    return { agent, ...runContext({ stateDir: options.stateDir, agent }) };
  };

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "longhorizon_verify",
        description:
          "Verify one claimed step against the real workspace using an independent verifier with a fresh context, then record the verdict in the verified-progress ledger. Use this before reporting any substantial step as done: only a clean, aligned, complete verdict is recorded as progress, and anything else is kept as evidence. The verifier reads files; it cannot write, and the workspace is fingerprinted before and after it runs so a verifier that changes anything is caught.",
        parameters: {
          claim: {
            type: "string",
            required: true,
            description: "The single claim to verify, phrased as something the workspace can confirm or contradict.",
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
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              round: { type: "integer", required: true },
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
              missing: strings(),
              evidence: strings(),
              task_state: { type: "string", required: true },
              verifier_provider: { type: "string", required: true },
              verifier_error: { type: "string" },
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

          await appendEvent({
            stateDir,
            runId,
            event: "verify_started",
            data: { round, claim: args.claim, workspace },
          });

          const snapshotBefore = await snapshotWorkspace(workspace);

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

          const snapshotAfter = await snapshotWorkspace(workspace);
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
          };

          await appendRound({ stateDir, runId, round: record });

          const summary = summarize({ verdict, diff, verifierError: record.verifierError, round });

          return {
            round,
            status: verdict.status,
            integrity: verdict.integrity,
            contract: verdict.contract,
            evidence_only: verdict.evidenceOnly,
            downgraded: verdict.downgraded,
            downgrade_reasons: verdict.downgradeReasons,
            workspace_mutated: diff.mutated,
            changed_paths: record.changedPaths,
            evidence_gaps: diff.evidenceGaps,
            missing: record.missing,
            evidence: record.evidence,
            task_state: record.taskState,
            verifier_provider: record.verifierProvider,
            ...(record.verifierError === "" ? {} : { verifier_error: record.verifierError }),
            summary,
          };
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "longhorizon_ledger",
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
        name: "longhorizon_state",
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
