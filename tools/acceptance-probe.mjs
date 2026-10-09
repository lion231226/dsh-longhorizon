/**
 * dsh-verified-progress — acceptance probe for the SHIPPED artifact.
 *
 * This is not another unit test. It runs the code that users actually install
 * (the packed tarball, unpacked) against the three claims the project makes, and
 * it writes a machine-readable verdict plus raw evidence to disk so a reviewer
 * can check the run instead of trusting a summary.
 *
 * Two disciplines are built in, because a probe that reports "0 failures"
 * without proving it ran is indistinguishable from a probe that never ran:
 *
 *  1. Self-proof of execution — the probe asserts it loaded the tool set from
 *     the artifact, that it created fresh fixtures, and that every scenario
 *     reached its deciding assertion. It writes scenario counts to the report.
 *  2. Positive control — the mutation scenario is constructed to *must* trip
 *     the guard (the verifier edits a file). If the guard ever fails to notice,
 *     `positiveControlTripped` is false and the whole run fails, so a broken
 *     detector cannot be reported as a pass.
 *
 * Usage:
 *   node tools/acceptance-probe.mjs [--artifact <unpacked-package-dir>]
 *                                   [--out <dir>]
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const OUT_DIR = path.resolve(arg("--out", path.join(REPO, "verify")));
const ARTIFACT = arg("--artifact", "");

/** The artifact's `registerTools`, resolved once in `main`. */
let registerToolsUnderTest = null;

/**
 * Rebuild the published artifact from `package.json#files`.
 *
 * This does not shell out to npm: `npm.cmd` cannot be spawned from Node on
 * Windows without a shell (EINVAL), and a shell would concatenate unescaped
 * arguments. Walking the manifest's own `files` list keeps the probe dependency
 * free and, more importantly, keeps it honest — what gets unpacked here is
 * exactly the set of files that would be published, so a missing `lib/` entry
 * fails the probe instead of passing against the working tree.
 */
async function packArtifact(outDir) {
  const packDir = path.join(outDir, "pack");
  await rm(packDir, { recursive: true, force: true });
  const staging = path.join(packDir, "package");
  await mkdir(staging, { recursive: true });

  const manifest = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"));
  const entries = [...(manifest.files ?? [])];
  // npm always includes these regardless of `files`.
  entries.push("package.json");
  if (manifest.main) entries.push(manifest.main);

  const included = [];
  for (const entry of entries) {
    const source = path.join(REPO, entry);
    const target = path.join(staging, entry);
    try {
      const info = await stat(source);
      if (info.isDirectory()) {
        await cp(source, target, { recursive: true });
        included.push(`${entry}/**`);
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await cp(source, target);
        included.push(entry);
      }
    } catch {
      // A missing entry is reported, not swallowed: a manifest that lists a
      // file the repo does not have is a real packaging defect.
      included.push(`MISSING:${entry}`);
    }
  }

  const tarballPath = path.join(packDir, `${manifest.name}-${manifest.version}.tgz`);
  const tarred = spawnSync("tar", ["-czf", tarballPath, "-C", packDir, "package"], { encoding: "utf8" });
  if (tarred.status !== 0) throw new Error(`tar failed: ${tarred.stderr}`);

  return { dir: staging, source: `packed:${path.basename(tarballPath)}`, included };
}

/**
 * Give the staged package the peer dependencies it resolves at install time.
 * The artifact ships no node_modules on purpose; resolution has to start from
 * somewhere, so link the repository's — the same shape an installed profile has.
 */
async function linkPeers(packageDir) {
  const linkTarget = path.join(REPO, "node_modules");
  const linkPath = path.join(packageDir, "node_modules");
  await rm(linkPath, { recursive: true, force: true });
  const link = spawnSync(
    process.platform === "win32" ? "cmd" : "ln",
    process.platform === "win32" ? ["/c", "mklink", "/J", linkPath, linkTarget] : ["-s", linkTarget, linkPath],
    { encoding: "utf8" },
  );
  if (link.status !== 0) throw new Error(`could not link node_modules for the probe: ${link.stderr}`);
}

/**
 * Run the shipped tool definitions with a scripted verifier.
 *
 * The verifier is the one thing that cannot be made deterministic without a
 * model, and it is also the one thing this probe is NOT testing: the subject is
 * what the harness does with a verdict, and whether it notices a verifier that
 * wrote to the workspace.
 */
async function loadTools(artifactDir) {
  // The shipped package declares its hosts as peer dependencies, so resolution
  // must start from the repository's linked node_modules.
  const entry = pathToFileURL(path.join(artifactDir, "lib", "tools.js")).href;
  const module = await import(entry);
  return module;
}

function makeContext({ script, stateDir }) {
  const registered = new Map();
  const calls = [];
  let childStarts = 0;

  const subagents = {
    list: () => ["spawn"],
    getProvider: () => ({ name: "spawn", inheritsParentContext: false }),
    start: async (_provider, request) => {
      childStarts += 1;
      calls.push(request);
      if (script.onVerify) await script.onVerify();
      return {
        id: `child-${childStarts}`,
        result: Promise.resolve({
          output: [{ type: "text", text: script.reply }],
          stopReason: script.stopReason ?? "completed",
        }),
      };
    },
  };

  const ctx = {
    tools: {
      register: (definition) => {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
    subagents,
    effect: (factory) => {
      const disposer = factory();
      return () => disposer?.();
    },
  };

  const dispose = registerToolsUnderTest(ctx, { stateDir });
  return { registered, dispose, get childStarts() { return childStarts; }, calls };
}

function execFor(workspace) {
  return {
    agent: { id: "probe-parent", session: { header: { id: "probe-session", cwd: workspace } } },
    signal: new AbortController().signal,
    callId: "probe-call",
    name: "probe",
    arguments: {},
  };
}

async function scratchWithin(parent, name) {
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, name));
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const scratchRoot = await scratchWithin(OUT_DIR, "scratch-");

  let artifact;
  if (ARTIFACT) {
    artifact = { dir: path.resolve(ARTIFACT), source: "explicit:--artifact", included: [] };
  } else {
    artifact = await packArtifact(OUT_DIR);
    await linkPeers(artifact.dir);
  }

  const toolsModule = await loadTools(artifact.dir);
  registerToolsUnderTest = toolsModule.registerTools;

  const scenarios = [];
  const rawEvidence = [];

  // ---------------------------------------------------------- scenario 1 ---
  // A verifier that behaves. The claim must end up as progress.
  {
    const stateDir = await scratchWithin(scratchRoot, "s1-state-");
    const workspace = await scratchWithin(scratchRoot, "s1-ws-");
    await writeFile(path.join(workspace, "artifact.txt"), "done");

    const ctx = makeContext({
      stateDir,
      script: {
        reply: [
          "Status: complete",
          "Integrity: clean",
          "Contract audit: aligned",
          "",
          "Evidence:",
          "- artifact.txt exists with the expected content",
          "",
          "Missing: None",
          "",
          "Task state: artifact.txt verified.",
        ].join("\n"),
      },
    });

    const result = await ctx.registered
      .get("verified_progress_verify")
      .execute(
        { claim: "artifact.txt exists", acceptance: "artifact.txt contains done" },
        execFor(workspace),
      );
    ctx.dispose();

    const ledgerRaw = await readFile(path.join(stateDir, "runs", "s-probe-session", "ledger.jsonl"), "utf8");

    scenarios.push({
      name: "clean-verdict-is-progress",
      passed:
        result.verdict.status === "complete" &&
        result.verdict.evidence_only === false &&
        ctx.childStarts === 1 &&
        ledgerRaw.includes('"verdict":"complete"'),
      observed: {
        status: result.verdict.status,
        evidence_only: result.verdict.evidence_only,
        verifier_episodes: ctx.childStarts,
        ledger_lines: ledgerRaw.trim().split("\n").length,
      },
    });
    rawEvidence.push({ scenario: "clean-verdict-is-progress", tool_result: result, ledger: ledgerRaw });
  }

  // ---------------------------------------------------------- scenario 2 ---
  // POSITIVE CONTROL: the verifier edits the workspace during a "read-only"
  // audit. The guard must notice and the round must not become progress.
  {
    const stateDir = await scratchWithin(scratchRoot, "s2-state-");
    const workspace = await scratchWithin(scratchRoot, "s2-ws-");
    await writeFile(path.join(workspace, "app.js"), "export const a = 1;\n");

    const ctx = makeContext({
      stateDir,
      script: {
        reply: ["Status: complete", "Integrity: clean", "Contract audit: aligned"].join("\n"),
        onVerify: async () => {
          await writeFile(path.join(workspace, "app.js"), "export const a = 2;\n");
        },
      },
    });

    const result = await ctx.registered
      .get("verified_progress_verify")
      .execute({ claim: "app.js exports a = 1" }, execFor(workspace));
    ctx.dispose();

    const ledgerRaw = await readFile(path.join(stateDir, "runs", "s-probe-session", "ledger.jsonl"), "utf8");

    scenarios.push({
      name: "positive-control-mutation-voids-verdict",
      passed:
        result.verdict.workspace_mutated === true &&
        result.verdict.status === "blocked" &&
        result.verdict.integrity === "violation" &&
        result.verdict.evidence_only === true &&
        ledgerRaw.includes('"verdict":"blocked"') &&
        !ledgerRaw.includes('"verdict":"complete"'),
      observed: {
        workspace_mutated: result.verdict.workspace_mutated,
        status: result.verdict.status,
        integrity: result.verdict.integrity,
        evidence_only: result.verdict.evidence_only,
        changed_paths: result.verdict.changed_paths,
      },
    });
    rawEvidence.push({ scenario: "positive-control-mutation-voids-verdict", tool_result: result, ledger: ledgerRaw });
  }

  // ---------------------------------------------------------- scenario 3 ---
  // Recovery: a fresh process reads the ledger written by the previous ones and
  // reports verified progress without replaying the conversation.
  {
    const stateDir = await scratchWithin(scratchRoot, "s3-state-");
    const workspace = await scratchWithin(scratchRoot, "s3-ws-");
    await writeFile(path.join(workspace, "step.txt"), "one");

    const first = makeContext({
      stateDir,
      script: { reply: "Status: complete\nIntegrity: clean\nContract audit: aligned" },
    });
    await first.registered.get("verified_progress_verify").execute({ claim: "step one" }, execFor(workspace));
    first.dispose();

    // A brand new context: no shared memory, only the ledger on disk.
    const second = makeContext({
      stateDir,
      script: { reply: "Status: complete\nIntegrity: clean\nContract audit: aligned" },
    });
    const readBack = await second.registered.get("verified_progress_ledger").execute({}, execFor(workspace));
    second.dispose();

    scenarios.push({
      name: "ledger-survives-a-fresh-context",
      passed:
        readBack.verified_rounds.length === 1 &&
        readBack.verified_rounds[0] === 1 &&
        readBack.rounds === 1 &&
        first.childStarts === 1,
      observed: {
        verified_rounds: readBack.verified_rounds,
        rejected_rounds: readBack.rejected_rounds,
        rounds: readBack.rounds,
        next_round: readBack.next_round,
      },
    });
    rawEvidence.push({ scenario: "ledger-survives-a-fresh-context", tool_result: readBack });
  }

  // -------------------------------------------------------- self-proof ----
  // Assert the probe itself did the work it claims: the artifact was loaded,
  // its tool set is complete, and every scenario reached a deciding assertion.
  const registeredNames = [...(await (async () => {
    const ctx = makeContext({ stateDir: await scratchWithin(scratchRoot, "self-state-"), script: { reply: "" } });
    const names = [...ctx.registered.keys()];
    ctx.dispose();
    return names;
  })())];

  const expectedTools = ["verified_progress_ledger", "verified_progress_state", "verified_progress_verify"];
  const selfProof = {
    artifact_loaded: registeredNames.length > 0,
    artifact_source: artifact.source,
    artifact_files: artifact.included ?? [],
    artifact_missing_files: (artifact.included ?? []).filter((entry) => entry.startsWith("MISSING:")),
    tool_names: registeredNames.sort(),
    tool_set_complete: expectedTools.every((tool) => registeredNames.includes(tool)),
    scenarios_run: scenarios.length,
    scenarios_decided: scenarios.filter((scenario) => typeof scenario.passed === "boolean").length,
    verifier_episodes_total: scenarios.reduce(
      (total, scenario) => total + (scenario.observed.verifier_episodes ?? 0),
      0,
    ),
  };

  const positiveControl = scenarios.find(
    (scenario) => scenario.name === "positive-control-mutation-voids-verdict",
  );
  const passed =
    selfProof.artifact_loaded &&
    selfProof.artifact_missing_files.length === 0 &&
    selfProof.tool_set_complete &&
    selfProof.scenarios_run === 3 &&
    selfProof.scenarios_decided === 3 &&
    scenarios.every((scenario) => scenario.passed === true) &&
    positiveControl?.passed === true;

  const report = {
    probe: "dsh-verified-progress acceptance",
    ranAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    // Repository-relative on purpose: the report is committed as evidence, and
    // a committed file should not publish whoever ran it their home directory.
    artifact: { source: artifact.source, dir: path.relative(REPO, artifact.dir) },
    selfProof,
    positiveControlTripped: positiveControl?.passed === true,
    scenarios,
    passed,
  };

  await writeFile(path.join(OUT_DIR, "acceptance-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(OUT_DIR, "acceptance-evidence.json"),
    `${JSON.stringify(rawEvidence, null, 2)}\n`,
    "utf8",
  );

  // Keep the fixtures used by the evidence so a reviewer can re-inspect them.
  await cp(scratchRoot, path.join(OUT_DIR, "fixtures"), { recursive: true }).catch(() => {});

  console.log(`artifact        : ${artifact.source}`);
  console.log(`tools registered: ${selfProof.tool_names.join(", ")}`);
  console.log(`tool set complete: ${selfProof.tool_set_complete}`);
  for (const scenario of scenarios) {
    console.log(`${scenario.passed ? "PASS" : "FAIL"}  ${scenario.name}`);
    console.log(`      ${JSON.stringify(scenario.observed)}`);
  }
  console.log(`positive control tripped: ${report.positiveControlTripped}`);
  console.log(`report: ${path.join(OUT_DIR, "acceptance-report.json")}`);
  console.log(report.passed ? "ACCEPTANCE: PASS" : "ACCEPTANCE: FAIL");

  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("acceptance probe crashed:", error);
  process.exitCode = 2;
});
