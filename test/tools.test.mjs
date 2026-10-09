/**
 * dsh-verified-progress — tool-level integration tests.
 *
 * These run the real `defineTool` definitions against a real (scratch) file
 * system, and replace exactly one thing: the verifier subagent. A scripted
 * verifier is the only way to test the invariant deterministically — the point
 * of the tests is "what does the harness do with a verdict", not "is a model a
 * good verifier".
 *
 * Run: node --test "test/**\/*.test.mjs"
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { registerTools, extractSection, extractSectionText } from "../lib/tools.js";
import { readLedger } from "../lib/core/ledger.js";

const SCRATCH_ROOT = path.join(process.cwd(), ".tmp");

async function scratch(t) {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(SCRATCH_ROOT, "lh-integration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Build a cordis-shaped context whose `ctx.tools.register` records definitions
 * instead of dispatching them, and whose `ctx.subagents` is scripted.
 *
 * @param {{ reply?: string, stopReason?: string, onVerify?: (workspace: string) => Promise<void>,
 *           providers?: string[] }} script
 */
function harness(script = {}) {
  const registered = new Map();
  const calls = [];
  const workspace = { current: "" };
  const disposals = { count: 0 };

  const subagents = {
    list: () => script.providers ?? ["spawn"],
    getProvider: (name) => ({ name, inheritsParentContext: name === "fork" }),
    start: async (_provider, request) => {
      calls.push(request);
      if (script.onVerify) await script.onVerify(workspace.current);
      const reply = script.reply ?? "Status: complete\nIntegrity: clean\nContract audit: aligned\n";
      return {
        id: "child-1",
        dispose: async () => {
          disposals.count += 1;
        },
        result: Promise.resolve({
          output: [{ type: "text", text: reply }],
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

  const dispose = registerTools(ctx, { stateDir: script.stateDir });
  return { ctx, registered, calls, workspace, disposals, dispose };
}

function execFor(workspace) {
  return {
    agent: {
      id: "parent-agent",
      session: { header: { id: "session-test", cwd: workspace } },
    },
    signal: new AbortController().signal,
    callId: "call-1",
    name: "test",
    arguments: {},
  };
}

async function callTool(registered, name, args, exec) {
  const definition = registered.get(name);
  assert.ok(definition, `tool ${name} was not registered`);
  return definition.execute(args, exec);
}

// ------------------------------------------------------ registration shape ---

test("tools: registers the three tools with a canonical output contract", (t) => {
  const h = harness();
  t.after(() => h.dispose());

  assert.deepEqual(
    [...h.registered.keys()].sort(),
    ["verified_progress_ledger", "verified_progress_state", "verified_progress_verify"],
  );
  for (const [name, definition] of h.registered) {
    assert.equal(definition.name, name);
    assert.equal(typeof definition.description, "string");
    assert.ok(definition.output?.schema, `${name} must declare an output schema`);
    const rendered = definition.output.render({}, { summary: "ok" });
    assert.ok(Array.isArray(rendered) && rendered[0]?.type === "text", `${name} render must return text blocks`);
  }
});

// --------------------------------------------------------------- verify ---

test("verify: a clean complete verdict is recorded as progress", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);
  await writeFile(path.join(workspace, "out.txt"), "done\n");

  const h = harness({
    stateDir,
    reply: [
      "Status: complete",
      "Integrity: clean",
      "Contract audit: aligned",
      "",
      "Evidence:",
      "- out.txt contains 'done'",
      "",
      "Missing: None",
      "",
      "Task state: out.txt exists with the expected content.",
    ].join("\n"),
    onVerify: async () => {},
  });
  t.after(() => h.dispose());
  h.workspace.current = workspace;

  const result = await callTool(
    h.registered,
    "verified_progress_verify",
    { claim: "out.txt was written", acceptance: "out.txt contains done" },
    execFor(workspace),
  );

  assert.equal(result.verdict.status, "complete");
  assert.equal(result.verdict.evidence_only, false);
  assert.equal(result.verdict.workspace_mutated, false);
  assert.deepEqual(result.evidence, ["out.txt contains 'done'"]);
  assert.equal(result.task_state, "out.txt exists with the expected content.");

  const ledger = await readLedger({ stateDir, runId: "s-session-test" });
  assert.equal(ledger.verified.length, 1, "the round must be in the ledger as verified");
  assert.equal(ledger.rounds[0].round, 1);
});

test("verify: complete + violation is downgraded to evidence only (positive control)", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);

  const h = harness({
    stateDir,
    reply: ["Status: complete", "Integrity: violation", "Contract audit: aligned"].join("\n"),
  });
  t.after(() => h.dispose());

  const result = await callTool(
    h.registered,
    "verified_progress_verify",
    { claim: "tests pass" },
    execFor(workspace),
  );

  assert.equal(result.verdict.status, "incomplete", "a violation must never be recorded as progress");
  assert.equal(result.verdict.evidence_only, true);
  assert.equal(result.verdict.downgraded, true);
  assert.ok(result.verdict.downgrade_reasons.some((reason) => reason.includes("violation")));

  const ledger = await readLedger({ stateDir, runId: "s-session-test" });
  assert.equal(ledger.verified.length, 0);
  assert.equal(ledger.rejected.length, 1);
});

test("verify: a verifier that mutates the workspace voids its own verdict", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);
  await writeFile(path.join(workspace, "app.js"), "export const a = 1;\n");

  const h = harness({
    stateDir,
    reply: ["Status: complete", "Integrity: clean", "Contract audit: aligned"].join("\n"),
    // The verifier is supposed to observe only. This one edits.
    onVerify: async (dir) => {
      await writeFile(path.join(dir, "app.js"), "export const a = 2;\n");
    },
  });
  t.after(() => h.dispose());
  h.workspace.current = workspace;

  const result = await callTool(
    h.registered,
    "verified_progress_verify",
    { claim: "app.js is correct" },
    execFor(workspace),
  );

  assert.equal(result.verdict.workspace_mutated, true);
  assert.equal(result.verdict.status, "blocked");
  assert.equal(result.verdict.integrity, "violation");
  assert.equal(result.verdict.evidence_only, true);
  assert.deepEqual(result.verdict.changed_paths, ["app.js"]);
});

test("verify: a missing Integrity line cannot yield complete", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);

  const h = harness({
    stateDir,
    reply: ["Status: complete", "Contract audit: aligned"].join("\n"),
  });
  t.after(() => h.dispose());

  const result = await callTool(h.registered, "verified_progress_verify", { claim: "x" }, execFor(workspace));
  assert.equal(result.verdict.status, "incomplete");
  assert.equal(result.verdict.evidence_only, true);
  assert.equal(result.verdict.integrity, "suspect", "an unstated integrity must never read as clean");
});

test("verify: a failed verifier episode records evidence, never progress", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);

  const h = harness({ stateDir, stopReason: "error", reply: "I could not check anything." });
  t.after(() => h.dispose());

  const result = await callTool(h.registered, "verified_progress_verify", { claim: "x" }, execFor(workspace));
  assert.equal(result.verdict.status, "incomplete");
  assert.equal(result.verdict.evidence_only, true);
  assert.match(result.verifier_error ?? "", /stopped with error/);
});

test("verify: no isolated provider means the claim cannot be certified", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);

  // Only a fork provider exists, which would inherit the executor's context.
  const h = harness({ stateDir, providers: ["fork"] });
  t.after(() => h.dispose());

  const result = await callTool(h.registered, "verified_progress_verify", { claim: "x" }, execFor(workspace));
  assert.equal(result.verdict.status, "incomplete");
  assert.equal(result.verdict.evidence_only, true);
  assert.match(result.verifier_error ?? "", /no subagent provider/i);
});

test("verify: rounds increment and the ledger accumulates across calls", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);
  const h = harness({ stateDir });
  t.after(() => h.dispose());

  const first = await callTool(h.registered, "verified_progress_verify", { claim: "step 1" }, execFor(workspace));
  const second = await callTool(h.registered, "verified_progress_verify", { claim: "step 2" }, execFor(workspace));

  assert.equal(first.round, 1);
  assert.equal(second.round, 2);

  const ledger = await readLedger({ stateDir, runId: "s-session-test" });
  assert.deepEqual(
    ledger.verified.map((round) => round.round),
    [1, 2],
  );
});

// --------------------------------------------------------------- readback ---

test("ledger and state tools report verified progress, not claims", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);

  // Round 1: rejected. Round 2: verified.
  let call = 0;
  const h = harness({
    stateDir,
    reply: "Status: complete\nIntegrity: violation\nContract audit: aligned",
    onVerify: async () => {
      call += 1;
    },
  });
  t.after(() => h.dispose());

  await callTool(h.registered, "verified_progress_verify", { claim: "first attempt" }, execFor(workspace));

  // Swap in a clean verdict for the second round by re-registering with a new script.
  const h2 = harness({
    stateDir,
    reply: [
      "Status: complete",
      "Integrity: clean",
      "Contract audit: aligned",
      "",
      "Evidence:",
      "- a.js:1 export const a = 1;",
      "",
      "Missing:",
      "- write b.js",
      "",
      "Task state: a.js verified; b.js pending.",
    ].join("\n"),
  });
  t.after(() => h2.dispose());

  await callTool(h2.registered, "verified_progress_verify", { claim: "second attempt" }, execFor(workspace));

  const ledger = await callTool(h2.registered, "verified_progress_ledger", {}, execFor(workspace));
  assert.equal(ledger.rounds, 2);
  assert.deepEqual(ledger.verified_rounds, [2]);
  assert.deepEqual(ledger.rejected_rounds, [1]);
  assert.equal(ledger.task_state, "a.js verified; b.js pending.");
  assert.deepEqual(ledger.open_items, ["write b.js"]);
  assert.equal(ledger.next_round, 3);

  const state = await callTool(h2.registered, "verified_progress_state", {}, execFor(workspace));
  assert.equal(state.verified, 1);
  assert.equal(state.rejected, 1);
  assert.equal(state.pending_claims.length, 1);
  assert.equal(state.pending_claims[0].claim, "first attempt");
  assert.ok(call >= 1);
});

test("ledger tool can hide rejected rounds", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);
  const h = harness({ stateDir, reply: "Status: complete\nIntegrity: violation\nContract audit: aligned" });
  t.after(() => h.dispose());

  await callTool(h.registered, "verified_progress_verify", { claim: "bad" }, execFor(workspace));
  const ledger = await callTool(
    h.registered,
    "verified_progress_ledger",
    { include_rejected: false },
    execFor(workspace),
  );
  assert.deepEqual(ledger.entries, []);
  assert.equal(ledger.rejected_rounds.length, 1, "the count stays honest even when entries are hidden");
});

// ------------------------------------------------------------- extraction ---

test("extraction: pulls labelled sections and treats None as empty", () => {
  const report = [
    "Status: complete",
    "",
    "Evidence:",
    "- src/a.js:12 exports run()",
    "- test/a.test.mjs:3 asserts it",
    "",
    "Missing: None",
    "",
    "Task state: a.js is verified and exported.",
  ].join("\n");

  assert.deepEqual(extractSection(report, "evidence"), ["src/a.js:12 exports run()", "test/a.test.mjs:3 asserts it"]);
  assert.deepEqual(extractSection(report, "missing"), []);
  assert.equal(extractSectionText(report, "task state"), "a.js is verified and exported.");
});

test("extraction: Chinese labels and inline values work", () => {
  const report = ["证据：", "- src/a.js 存在", "", "缺口：- 缺 b.js", "", "任务状态：a 已完成"].join("\n");
  assert.deepEqual(extractSection(report, "证据"), ["src/a.js 存在"]);
  assert.deepEqual(extractSection(report, "缺口"), ["缺 b.js"]);
  assert.equal(extractSectionText(report, "任务状态"), "a 已完成");
});

test("extraction: an absent section yields nothing rather than the whole report", () => {
  const report = "Status: complete\nIntegrity: clean\nContract audit: aligned\n";
  assert.deepEqual(extractSection(report, "missing"), []);
  assert.equal(extractSectionText(report, "task state"), "");
});

// --------------------------------------------------------------- disposal ---

test("verify: the verifier run is disposed on the success path", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);
  const h = harness({ stateDir });
  t.after(() => h.dispose());

  await callTool(h.registered, "verified_progress_verify", { claim: "x" }, execFor(workspace));

  // Subagent slots are bounded (maxActiveSubagents is 8-10 by default) and only
  // come back from dispose(). A leak here would let the plugin work for a few
  // rounds and then silently stop being able to start any verifier at all.
  assert.equal(h.disposals.count, 1, "the subagent run must be disposed exactly once");
});

test("verify: the verifier run is disposed when the verifier fails", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);
  const h = harness({ stateDir, stopReason: "error", reply: "could not check" });
  t.after(() => h.dispose());

  const result = await callTool(h.registered, "verified_progress_verify", { claim: "x" }, execFor(workspace));

  assert.equal(result.verdict.evidence_only, true);
  assert.equal(h.disposals.count, 1, "a failed episode must still release its slot");
});

// ------------------------------------------------------------ persistence ---

test("verifier tool set: every name exists in the host registry, and none can write", async () => {
  const { VERIFIER_TOOLS } = await import("../lib/verifier.js");

  // Captured from a live harness (`tools.restrict()` prints the registry when it
  // rejects a name). A stale name here does not fail loudly — it makes
  // `tools.restrict()` reject the whole restriction, which makes every
  // verification episode fail, which downgrades every round to `incomplete`.
  // That is exactly the silent, total failure this project exists to prevent.
  const KNOWN_GLOBAL_TOOLS = new Set([
    "create_goal", "edit", "exit_plan_mode", "get_goal", "glob", "grep",
    "interrupt_agent", "job_kill", "job_list", "job_output", "list_agents",
    "verified_progress_ledger", "verified_progress_state", "verified_progress_verify", "pwsh",
    "read", "read_image", "send_message", "skill", "subagent", "subagent_fork",
    "todo_write", "update_goal", "web_fetch", "web_search", "workflow", "write",
  ]);

  const unknown = VERIFIER_TOOLS.filter((tool) => !KNOWN_GLOBAL_TOOLS.has(tool));
  assert.deepEqual(unknown, [], `verifier tool names not in the host registry: ${unknown.join(", ")}`);

  // Structural constraint, not a comment: the verifier observes, it never writes.
  const FORBIDDEN = ["write", "edit", "pwsh", "subagent", "subagent_fork", "workflow", "skill"];
  const offenders = VERIFIER_TOOLS.filter((tool) => FORBIDDEN.includes(tool));
  assert.deepEqual(
    offenders,
    [],
    `write-capable tools must never be granted to the verifier: ${offenders.join(", ")}`,
  );

  assert.ok(VERIFIER_TOOLS.includes("read"), "the verifier must at least be able to read files");
});

test("state.json is written next to the ledger and is readable", async (t) => {
  const stateDir = await scratch(t);
  const workspace = await scratch(t);
  const h = harness({ stateDir });
  t.after(() => h.dispose());

  await callTool(h.registered, "verified_progress_verify", { claim: "x" }, execFor(workspace));

  const stateFile = path.join(stateDir, "runs", "s-session-test", "state.json");
  const parsed = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(parsed.verifiedRounds, [1]);
  assert.equal(parsed.rounds, 1);
});
