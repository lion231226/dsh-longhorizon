/**
 * dsh-verified-progress — append-only verified-progress ledger.
 *
 * The ledger is the durable half of the loop. A `todo` list written by the
 * executing agent is a *claim*; it is cleared on every turn and lives only in
 * the transcript. This ledger records the subset of claims that an independent
 * verifier actually confirmed against the workspace, so that a crashed process,
 * a compacted context, or a fresh session can still answer "what is really
 * done, and what is left".
 *
 * Layout, under one run directory:
 *
 *     <stateDir>/runs/<runId>/ledger.jsonl      append-only rounds + events
 *     <stateDir>/runs/<runId>/state.json        last-wins projection (atomic)
 *
 * Durability rules (all portable — no POSIX-only flags):
 *  - one JSON object per line, `\n` terminated, appended with the file opened
 *    `O_APPEND` and followed by fsync, so a crash cannot lose an accepted round;
 *  - the reader tolerates a torn tail line (a crash mid-write) by skipping it
 *    and reporting that it did, instead of failing the whole resume;
 *  - a round index may appear more than once (a late decision re-records it);
 *    the **last** entry wins, which is what makes re-recording safe;
 *  - the read is bounded by maxBytes. Going over is reported as a truncation
 *    warning and the ledger degrades to "read the tail", never silently to
 *    "start from zero".
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_FILE = "ledger.jsonl";
export const STATE_FILE = "state.json";
export const DEFAULT_MAX_LEDGER_BYTES = 32 * 1024 * 1024;

/**
 * @typedef {object} LedgerRound
 * @property {"round"} type
 * @property {number} schemaVersion
 * @property {string} eventId
 * @property {number} ts
 * @property {number} round
 * @property {"complete"|"incomplete"|"blocked"} verdict
 * @property {"clean"|"suspect"|"violation"} integrity
 * @property {"aligned"|"unknown"|"needs_revision"|"invalid"} contract
 * @property {string} claim        what the executor asserted
 * @property {string} taskState    verifier-maintained state summary
 * @property {string[]} evidence   paths/commands the verifier actually inspected
 * @property {string[]} missing    what remains, per the verifier
 * @property {string[]} changedPaths
 * @property {string[]} downgradeReasons
 * @property {boolean} downgraded
 */

function nowMs() {
  return Date.now();
}

export function runDirFor(stateDir, runId) {
  return path.join(stateDir, "runs", runId);
}

export function ledgerPathFor(stateDir, runId) {
  return path.join(runDirFor(stateDir, runId), LEDGER_FILE);
}

export function statePathFor(stateDir, runId) {
  return path.join(runDirFor(stateDir, runId), STATE_FILE);
}

/** Stable run id from a working directory + session, so a resume reopens it. */
export function deriveRunId({ workspace, sessionId }) {
  if (sessionId) return `s-${String(sessionId).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)}`;
  const digest = createHash("sha256").update(String(workspace ?? "")).digest("hex").slice(0, 12);
  return `w-${digest}`;
}

/**
 * A per-file append queue. Two awaits interleaved on the same ledger must not
 * interleave their bytes, and callers should not have to know that.
 */
const appendChains = new Map();

async function withAppendLock(file, task) {
  const previous = appendChains.get(file) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  appendChains.set(
    file,
    previous.then(() => current),
  );
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (appendChains.get(file) === current) appendChains.delete(file);
  }
}

/**
 * Append one record durably. Returns the assigned `eventId`.
 *
 * @param {object} args
 * @param {string} args.stateDir
 * @param {string} args.runId
 * @param {Record<string, unknown>} args.record
 */
export async function appendRecord({ stateDir, runId, record }) {
  const dir = runDirFor(stateDir, runId);
  const file = path.join(dir, LEDGER_FILE);
  await mkdir(dir, { recursive: true });

  return withAppendLock(file, async () => {
    const sequence = await nextSequence(file);
    const eventId = `${runId}:${String(sequence).padStart(6, "0")}`;
    const line = `${JSON.stringify({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      eventId,
      ts: nowMs(),
      ...record,
    })}\n`;

    const handle = await open(file, "a");
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return eventId;
  });
}

async function nextSequence(file) {
  const { records } = await readLedgerFile(file);
  return records.length + 1;
}

export async function appendRound({ stateDir, runId, round }) {
  const eventId = await appendRecord({
    stateDir,
    runId,
    record: { type: "round", ...round },
  });
  await writeState({ stateDir, runId });
  return eventId;
}

export async function appendEvent({ stateDir, runId, event, data = {} }) {
  return appendRecord({ stateDir, runId, record: { type: "event", event, ...data } });
}

/**
 * Parse a ledger file, tolerating a torn tail.
 *
 * @param {string} file
 * @param {{maxBytes?: number}} [options]
 */
export async function readLedgerFile(file, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LEDGER_BYTES;
  /** @type {object[]} */
  const records = [];
  const warnings = [];

  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { records, warnings, truncated: false, bytes: 0 };
    throw error;
  }

  const bytes = Buffer.byteLength(text, "utf8");
  let truncated = false;
  if (bytes > maxBytes) {
    truncated = true;
    warnings.push(
      `ledger is ${bytes} bytes, above the ${maxBytes}-byte read budget; only the newest records were loaded`,
    );
    const keep = text.slice(-maxBytes);
    text = keep.slice(keep.indexOf("\n") + 1);
  }

  const lines = text.split("\n");
  // The final element is empty for a well-formed file; anything else means the
  // last write was cut short by a crash.
  const lastIndex = lines.length - 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      if (index === lastIndex) continue;
      warnings.push(`blank line at ${index + 1} skipped`);
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") records.push(parsed);
      else warnings.push(`line ${index + 1} is not an object; skipped`);
    } catch {
      if (index === lastIndex) {
        warnings.push(`torn tail line ${index + 1} skipped (interrupted write)`);
      } else {
        warnings.push(`unparsable line ${index + 1} skipped`);
      }
    }
  }

  return { records, warnings, truncated, bytes };
}

/**
 * Rebuild the run's state from the ledger. Rounds are last-wins by `round`.
 *
 * @param {object} args
 * @param {string} args.stateDir
 * @param {string} args.runId
 * @param {number} [args.maxBytes]
 */
export async function readLedger({ stateDir, runId, maxBytes }) {
  const file = ledgerPathFor(stateDir, runId);
  const { records, warnings, truncated, bytes } = await readLedgerFile(file, { maxBytes });

  /** @type {Map<number, LedgerRound>} */
  const byRound = new Map();
  const events = [];
  for (const record of records) {
    if (record.type === "round" && Number.isInteger(record.round) && record.round >= 1) {
      byRound.set(record.round, /** @type {LedgerRound} */ (record));
    } else if (record.type === "event") {
      events.push(record);
    }
  }

  const rounds = [...byRound.values()].sort((a, b) => a.round - b.round);
  const verified = rounds.filter((round) => round.verdict === "complete" && round.integrity === "clean");
  const rejected = rounds.filter((round) => round.verdict !== "complete");

  return {
    runId,
    file,
    bytes,
    truncated,
    warnings,
    rounds,
    events,
    verified,
    rejected,
    nextRound: rounds.length === 0 ? 1 : rounds[rounds.length - 1].round + 1,
    evidenceOnly: rejected.map((round) => ({
      round: round.round,
      claim: round.claim,
      reasons: round.downgradeReasons ?? [],
    })),
  };
}

/**
 * Write the last-wins projection. Readable by a human and by a future turn that
 * only wants "current verified state + what is left".
 */
export async function writeState({ stateDir, runId }) {
  const ledger = await readLedger({ stateDir, runId });
  const state = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    runId,
    updatedAt: new Date().toISOString(),
    rounds: ledger.rounds.length,
    verifiedRounds: ledger.verified.map((round) => round.round),
    rejectedRounds: ledger.rejected.map((round) => round.round),
    taskState: lastText(ledger.verified, "taskState"),
    openItems: lastArray(ledger.verified, "missing"),
    pendingClaims: ledger.rejected.map((round) => ({ claim: round.claim, reasons: round.downgradeReasons ?? [] })),
    evidence: lastArray(ledger.verified, "evidence"),
    warnings: ledger.warnings,
  };
  await writeJsonAtomic(statePathFor(stateDir, runId), state);
  return state;
}

export async function readState({ stateDir, runId }) {
  try {
    return JSON.parse(await readFile(statePathFor(stateDir, runId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function lastText(rounds, key) {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const value = rounds[index][key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

function lastArray(rounds, key) {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const value = rounds[index][key];
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

/**
 * Atomic JSON write: temp file in the same directory, then rename. A reader
 * either sees the previous complete file or the new complete file.
 */
export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
  return file;
}
