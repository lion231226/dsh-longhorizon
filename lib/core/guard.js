/**
 * dsh-longhorizon — workspace mutation guard.
 *
 * Why this exists: a verifier that runs with the same write permissions as the
 * executor can "verify" its own edits. The only cheap, model-independent way to
 * catch that is to fingerprint the workspace immediately before and after the
 * verification episode and compare. If anything changed, the read-only premise
 * of the audit was false and the verdict is void.
 *
 * Deliberately no O_NOFOLLOW / dir-fd / POSIX locking here. Those primitives
 * are what makes the upstream LongHorizon-Harness persistent layer fail closed
 * on Windows (os.O_NOFOLLOW, os.O_DIRECTORY and supports_dir_fd are all absent
 * on win32). The guard is a correctness tool, not a security boundary against a
 * local attacker, so it uses portable Node APIs only.
 *
 * Snapshot cost is bounded on purpose:
 *  - every file contributes its size + mtime, which catches all rewrites;
 *  - files up to maxHashBytes additionally contribute a SHA-256 of their bytes,
 *    which catches same-size same-mtime rewrites that mtime granularity could
 *    otherwise hide;
 *  - larger files are tracked by stat only, and the snapshot records that they
 *    were not hashed so a caller can tell "unchanged" from "not compared".
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Directories that are never task content. `.lh` is this plugin's own state
 * directory; the rest are VCS/build noise that would swamp the guard without
 * saying anything about the executor's work.
 */
export const DEFAULT_EXCLUDED_DIRS = [
  ".git",
  ".hg",
  ".svn",
  ".lh",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".turbo",
  ".next",
  "dist",
  "build",
  "target",
];

export const DEFAULT_MAX_FILES = 20000;
export const DEFAULT_MAX_HASH_BYTES = 2 * 1024 * 1024;

/**
 * @typedef {object} SnapshotOptions
 * @property {string[]} [excludeDirs] directory names to skip anywhere in the tree
 * @property {number} [maxFiles] stop after this many entries (snapshot reports truncation)
 * @property {number} [maxHashBytes] files larger than this are stat-only
 * @property {(p: string) => boolean} [filter] absolute-path predicate; return false to skip
 */

/**
 * Fingerprint a directory tree.
 *
 * @param {string} root
 * @param {SnapshotOptions} [options]
 * @returns {Promise<{root: string, records: Map<string, object>, truncated: boolean,
 *                    fileCount: number, errors: string[], hashedBytes: number}>}
 */
export async function snapshotWorkspace(root, options = {}) {
  const excludeDirs = new Set(options.excludeDirs ?? DEFAULT_EXCLUDED_DIRS);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxHashBytes = options.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES;
  const filter = options.filter;

  /** @type {Map<string, object>} */
  const records = new Map();
  const errors = [];
  let truncated = false;
  let hashedBytes = 0;

  const stack = [root];
  while (stack.length > 0) {
    if (records.size >= maxFiles) {
      truncated = true;
      break;
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      errors.push(`${dir}: ${error.code ?? error.message}`);
      continue;
    }
    for (const entry of entries) {
      if (records.size >= maxFiles) {
        truncated = true;
        break;
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        if (filter && !filter(absolute)) continue;
        stack.push(absolute);
        continue;
      }
      if (filter && !filter(absolute)) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      try {
        const info = await stat(absolute);
        if (entry.isSymbolicLink()) {
          records.set(relative, { kind: "symlink", mtimeMs: info.mtimeMs });
          continue;
        }
        if (!info.isFile()) {
          records.set(relative, { kind: "other", mtimeMs: info.mtimeMs, size: info.size });
          continue;
        }
        /** @type {{kind: string, size: number, mtimeMs: number, sha256?: string, hashed: boolean}} */
        const record = { kind: "file", size: info.size, mtimeMs: info.mtimeMs, hashed: false };
        if (info.size <= maxHashBytes) {
          const bytes = await readFile(absolute);
          record.sha256 = createHash("sha256").update(bytes).digest("hex");
          record.hashed = true;
          hashedBytes += info.size;
        }
        records.set(relative, record);
      } catch (error) {
        errors.push(`${absolute}: ${error.code ?? error.message}`);
      }
    }
  }

  return { root, records, truncated, fileCount: records.size, errors, hashedBytes };
}

/**
 * Compare two snapshots taken from the same root.
 *
 * @param {Awaited<ReturnType<typeof snapshotWorkspace>>} before
 * @param {Awaited<ReturnType<typeof snapshotWorkspace>>} after
 * @returns {{added: string[], removed: string[], changed: string[], typeChanged: string[],
 *            mutated: boolean, counts: {added: number, removed: number, changed: number, typeChanged: number},
 *            evidenceGaps: string[]}}
 */
export function diffSnapshots(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  const typeChanged = [];

  for (const [relative, record] of after.records) {
    if (!before.records.has(relative)) added.push(relative);
    else {
      const previous = before.records.get(relative);
      if (previous.kind !== record.kind) typeChanged.push(relative);
      else if (!sameRecord(previous, record)) changed.push(relative);
    }
  }
  for (const relative of before.records.keys()) {
    if (!after.records.has(relative)) removed.push(relative);
  }

  added.sort();
  removed.sort();
  changed.sort();
  typeChanged.sort();

  // An incomplete snapshot means "unchanged" is not a trustworthy conclusion.
  // Surfacing it here keeps the guard from reporting a clean audit it cannot
  // actually vouch for.
  const evidenceGaps = [];
  if (before.truncated || after.truncated) evidenceGaps.push("snapshot was truncated by maxFiles");
  const errorCount = before.errors.length + after.errors.length;
  if (errorCount > 0) evidenceGaps.push(`${errorCount} path(s) could not be read`);
  const unhashed = [...after.records.values()].filter((record) => record.kind === "file" && !record.hashed).length;
  if (unhashed > 0) evidenceGaps.push(`${unhashed} file(s) above maxHashBytes compared by size+mtime only`);

  return {
    added,
    removed,
    changed,
    typeChanged,
    mutated: added.length + removed.length + changed.length + typeChanged.length > 0,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      typeChanged: typeChanged.length,
    },
    evidenceGaps,
  };
}

function sameRecord(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.size !== b.size) return false;
  if (a.mtimeMs !== b.mtimeMs) return false;
  if (a.kind === "symlink") return true;
  if (a.hashed && b.hashed) return a.sha256 === b.sha256;
  // One side was too large to hash: size+mtime equality is all we have, and the
  // snapshot already recorded that as an evidence gap.
  return true;
}

/** Human-readable one-liner for logs and tool results. */
export function describeDiff(diff) {
  if (!diff.mutated) {
    const suffix = diff.evidenceGaps.length > 0 ? ` (${diff.evidenceGaps.join("; ")})` : "";
    return `workspace unchanged${suffix}`;
  }
  const parts = [];
  if (diff.counts.added) parts.push(`+${diff.counts.added}`);
  if (diff.counts.changed) parts.push(`~${diff.counts.changed}`);
  if (diff.counts.removed) parts.push(`-${diff.counts.removed}`);
  if (diff.counts.typeChanged) parts.push(`type:${diff.counts.typeChanged}`);
  return `workspace mutated (${parts.join(" ")})`;
}
