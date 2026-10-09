/**
 * dsh-longhorizon — core logic tests.
 *
 * Run: node --test "test/**\/*.test.mjs"
 *
 * Two disciplines are enforced here on purpose:
 *  1. Every "detector" test includes a positive control — a case that must be
 *     caught. A guard that reports "clean" because it never ran is
 *     indistinguishable from a guard that reports "clean" and works.
 *  2. The torn-tail and missing-line tests assert the *conservative* outcome,
 *     because those are the paths a crashing or lazy verifier will take.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseVerdict, enforceVerdict, judge } from "../lib/core/verdict.js";
import { snapshotWorkspace, diffSnapshots } from "../lib/core/guard.js";
import {
  appendRound,
  appendEvent,
  readLedger,
  readState,
  writeState,
  deriveRunId,
} from "../lib/core/ledger.js";

// Scratch space lives inside the repository rather than os.tmpdir(): the
// harness may run with a sandbox that does not grant write access to the
// platform temp directory, and a test that cannot create its own fixture is
// indistinguishable from a test whose subject is broken.
const SCRATCH_ROOT = path.join(process.cwd(), ".tmp");

async function tempDir(t) {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(SCRATCH_ROOT, "lh-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- verdict ---

test("verdict: parses the three control lines", () => {
  const parsed = parseVerdict(
    ["Status: complete", "Integrity: clean", "Contract audit: aligned", "", "notes..."].join("\n"),
  );
  assert.deepEqual(parsed.stated, { status: true, integrity: true, contract: true });
  assert.equal(parsed.status, "complete");
  assert.equal(parsed.integrity, "clean");
  assert.equal(parsed.contract, "aligned");
});

test("verdict: parses bold, bulleted and Chinese control lines", () => {
  const bold = parseVerdict("**Status: incomplete**\n**Integrity: suspect**\n**Contract audit: needs_revision**");
  assert.equal(bold.status, "incomplete");
  assert.equal(bold.integrity, "suspect");
  assert.equal(bold.contract, "needs_revision");

  const zh = parseVerdict("状态：完成\n完整性：clean\n契约审计：对齐");
  assert.equal(zh.status, "complete");
  assert.equal(zh.integrity, "clean");
  assert.equal(zh.contract, "aligned");

  const bulleted = parseVerdict("- Status: blocked\n- Integrity: violation\n- Contract audit: invalid");
  assert.equal(bulleted.status, "blocked");
  assert.equal(bulleted.integrity, "violation");
  assert.equal(bulleted.contract, "invalid");
});

test("verdict: does not mistake narrative text for a control line", () => {
  const parsed = parseVerdict(
    "I checked the files and the status: complete story is not what happened here, because integrity: clean was never proven.",
  );
  // Inline mentions are mid-sentence, so they must not match an anchored line.
  assert.equal(parsed.status, null);
  assert.equal(parsed.integrity, null);
});

test("verdict invariant: a clean complete verdict passes through unchanged", () => {
  const result = judge("Status: complete\nIntegrity: clean\nContract audit: aligned");
  assert.equal(result.status, "complete");
  assert.equal(result.downgraded, false);
  assert.equal(result.evidenceOnly, false);
});

test("verdict invariant: complete + violation is downgraded (positive control)", () => {
  const result = judge("Status: complete\nIntegrity: violation\nContract audit: aligned");
  assert.equal(result.status, "incomplete", "a violation must never be promoted to progress");
  assert.equal(result.downgraded, true);
  assert.equal(result.evidenceOnly, true);
  assert.ok(result.downgradeReasons.some((reason) => reason.includes("violation")));
});

test("verdict invariant: complete + non-aligned contract is downgraded (positive control)", () => {
  const result = judge("Status: complete\nIntegrity: clean\nContract audit: needs_revision");
  assert.equal(result.status, "incomplete");
  assert.equal(result.downgraded, true);
});

test("verdict: a missing control line degrades conservatively, never to complete", () => {
  const missingIntegrity = judge("Status: complete\nContract audit: aligned");
  assert.equal(missingIntegrity.status, "incomplete");
  assert.equal(missingIntegrity.integrity, "suspect");
  assert.equal(missingIntegrity.evidenceOnly, true);

  const empty = judge("");
  assert.equal(empty.status, "incomplete");
  assert.equal(empty.integrity, "suspect");
  assert.equal(empty.contract, "unknown");
});

test("verdict: verifier mutating the workspace voids its own verdict", () => {
  const result = judge("Status: complete\nIntegrity: clean\nContract audit: aligned", {
    verifierMutatedWorkspace: true,
    changedPaths: ["src/app.js"],
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.integrity, "violation");
  assert.equal(result.evidenceOnly, true);
});

test("verdict: contract aliases normalise", () => {
  assert.equal(parseVerdict("Contract audit: needs revision").contract, "needs_revision");
  assert.equal(parseVerdict("Contract-Audit: INVALID").contract, "invalid");
  assert.equal(parseVerdict("contract_audit: unKNOWN").contract, "unknown");
});

// ------------------------------------------------------------------ guard ---

test("guard: reports unchanged for a stable tree", async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.js"), "export const a = 1;\n");

  const before = await snapshotWorkspace(dir);
  const after = await snapshotWorkspace(dir);
  const diff = diffSnapshots(before, after);

  assert.equal(diff.mutated, false);
  assert.equal(diff.counts.added + diff.counts.changed + diff.counts.removed, 0);
});

test("guard: detects add, modify and delete (positive control)", async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "keep.js"), "keep\n");
  await writeFile(path.join(dir, "src", "change.js"), "before\n");
  await writeFile(path.join(dir, "src", "remove.js"), "remove me\n");

  const before = await snapshotWorkspace(dir);

  await writeFile(path.join(dir, "src", "change.js"), "after\n");
  await writeFile(path.join(dir, "src", "added.js"), "new\n");
  await rm(path.join(dir, "src", "remove.js"));

  const diff = diffSnapshots(before, await snapshotWorkspace(dir));
  assert.equal(diff.mutated, true);
  assert.deepEqual(diff.added, ["src/added.js"]);
  assert.deepEqual(diff.changed, ["src/change.js"]);
  assert.deepEqual(diff.removed, ["src/remove.js"]);
});

test("guard: detects a same-size rewrite via the content hash", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "same-size.txt");
  await writeFile(file, "AAAA\n");
  const before = await snapshotWorkspace(dir);

  await writeFile(file, "BBBB\n"); // identical length
  const after = await snapshotWorkspace(dir);
  const diff = diffSnapshots(before, after);

  assert.equal(diff.mutated, true, "same-size rewrite must be caught by the hash");
  assert.deepEqual(diff.changed, ["same-size.txt"]);
});

test("guard: excluded directories are not fingerprinted", async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "x\n");
  await writeFile(path.join(dir, "app.js"), "y\n");

  const snapshot = await snapshotWorkspace(dir);
  assert.deepEqual([...snapshot.records.keys()], ["app.js"]);
});

test("guard: reports an evidence gap instead of a clean bill of health when it could not hash", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "big.bin"), "0123456789");

  const before = await snapshotWorkspace(dir, { maxHashBytes: 4 });
  const after = await snapshotWorkspace(dir, { maxHashBytes: 4 });
  const diff = diffSnapshots(before, after);

  assert.equal(diff.mutated, false);
  assert.ok(
    diff.evidenceGaps.some((gap) => gap.includes("maxHashBytes")),
    "an unhashed file must be surfaced as an evidence gap",
  );
});

// ----------------------------------------------------------------- ledger ---

test("ledger: appends rounds and rebuilds verified state", async (t) => {
  const stateDir = await tempDir(t);
  const runId = "run-a";

  await appendRound({
    stateDir,
    runId,
    round: {
      round: 1,
      verdict: "incomplete",
      integrity: "clean",
      contract: "aligned",
      claim: "wrote the parser",
      downgraded: true,
      downgradeReasons: ["verifier did not state a Status line"],
    },
  });
  await appendRound({
    stateDir,
    runId,
    round: {
      round: 2,
      verdict: "complete",
      integrity: "clean",
      contract: "aligned",
      claim: "parser tests pass",
      taskState: "parser done; writer pending",
      evidence: ["test/parser.test.mjs"],
      missing: ["write the writer"],
      changedPaths: [],
    },
  });

  const ledger = await readLedger({ stateDir, runId });
  assert.equal(ledger.rounds.length, 2);
  assert.deepEqual(
    ledger.verified.map((round) => round.round),
    [2],
  );
  assert.deepEqual(ledger.rejected.map((round) => round.round), [1]);
  assert.equal(ledger.nextRound, 3);

  const state = await readState({ stateDir, runId });
  assert.equal(state.taskState, "parser done; writer pending");
  assert.deepEqual(state.openItems, ["write the writer"]);
  assert.equal(state.pendingClaims.length, 1);
});

test("ledger: last entry wins for a repeated round index", async (t) => {
  const stateDir = await tempDir(t);
  const runId = "run-dup";
  const base = { round: 1, integrity: "clean", contract: "aligned" };

  await appendRound({ stateDir, runId, round: { ...base, verdict: "incomplete", claim: "first" } });
  await appendRound({ stateDir, runId, round: { ...base, verdict: "complete", claim: "corrected" } });

  const ledger = await readLedger({ stateDir, runId });
  assert.equal(ledger.rounds.length, 1);
  assert.equal(ledger.rounds[0].claim, "corrected");
  assert.equal(ledger.rounds[0].verdict, "complete");
});

test("ledger: a torn tail line is skipped and reported, not fatal", async (t) => {
  const stateDir = await tempDir(t);
  const runId = "run-torn";

  await appendRound({
    stateDir,
    runId,
    round: { round: 1, verdict: "complete", integrity: "clean", contract: "aligned", claim: "ok" },
  });

  const file = path.join(stateDir, "runs", runId, "ledger.jsonl");
  const existing = await readFile(file, "utf8");
  await writeFile(file, `${existing}{"schemaVersion":1,"type":"round","round":2,"ver`);

  const ledger = await readLedger({ stateDir, runId });
  assert.equal(ledger.rounds.length, 1, "the complete round must survive a torn tail");
  assert.ok(
    ledger.warnings.some((warning) => warning.includes("torn tail")),
    "the torn tail must be reported rather than silently dropped",
  );
});

test("ledger: reads nothing (not a crash) for an unknown run", async (t) => {
  const stateDir = await tempDir(t);
  const ledger = await readLedger({ stateDir, runId: "does-not-exist" });
  assert.equal(ledger.rounds.length, 0);
  assert.equal(ledger.nextRound, 1);
  assert.deepEqual(ledger.warnings, []);
});

test("ledger: events are kept separate from rounds", async (t) => {
  const stateDir = await tempDir(t);
  const runId = "run-events";
  await appendEvent({ stateDir, runId, event: "run_started", data: { workspace: "C:/tmp" } });
  await appendRound({
    stateDir,
    runId,
    round: { round: 1, verdict: "incomplete", integrity: "suspect", contract: "unknown", claim: "x" },
  });
  const ledger = await readLedger({ stateDir, runId });
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].event, "run_started");
  assert.equal(ledger.rounds.length, 1);
});

test("ledger: writeState is idempotent and readable", async (t) => {
  const stateDir = await tempDir(t);
  const runId = "run-state";
  await appendRound({
    stateDir,
    runId,
    round: {
      round: 1,
      verdict: "complete",
      integrity: "clean",
      contract: "aligned",
      claim: "done",
      taskState: "everything verified",
    },
  });
  const first = await writeState({ stateDir, runId });
  const second = await writeState({ stateDir, runId });
  assert.deepEqual(first.verifiedRounds, second.verifiedRounds);
  assert.equal(second.taskState, "everything verified");
});

test("ledger: run id is stable for a workspace and prefers the session", () => {
  assert.equal(deriveRunId({ workspace: "C:/w", sessionId: "sess-1" }), "s-sess-1");
  const a = deriveRunId({ workspace: "C:/w" });
  const b = deriveRunId({ workspace: "C:/w" });
  const c = deriveRunId({ workspace: "C:/other" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
