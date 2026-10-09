/**
 * Install dsh-verified-progress into a DSH profile, the way dsh-peak-hours is
 * installed on this machine.
 *
 * Why not `dsh plugin add`: the desktop profile is held by the running Electron
 * application, and `add` runs pnpm, which rewrites package.json, the lockfile
 * and node_modules underneath it. The proven method for a profile in use is:
 *
 *   1. copy the package into <profile>/node_modules/<name>
 *   2. add one `insert` row to <profile>/cordis.patch.yml
 *
 * Safety, because a broken cordis.patch.yml stops the whole profile from
 * composing and an empty one refuses to start:
 *   - the patch file is parsed and re-serialised through js-yaml; a file that
 *     fails to parse is never written
 *   - a timestamped backup is taken before the first write
 *   - the result is parsed again after writing
 *   - re-running is idempotent: the managed block is replaced, not appended
 *
 * Usage:
 *   node tools/install-into-profile.mjs [--profile <name>] [--source <dir>]
 *                                       [--dry-run] [--uninstall]
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const PACKAGE_NAME = "dsh-verified-progress";
const ROW_ID = "verified-progress";
const BEGIN = `# >>> ${PACKAGE_NAME} (managed block; do not edit by hand) >>>`;
const END = `# <<< ${PACKAGE_NAME} (managed block) <<<`;
const COPIED = ["lib", "cordis.patch.yml", "README.md", "README.zh-CN.md", "LICENSE", "package.json"];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const has = (flag) => process.argv.includes(flag);

const profileName = arg("--profile", "desktop");
const sourceDir = path.resolve(arg("--source", REPO));
const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
const profileDir = path.join(dshHome, "profiles", profileName);
const targetDir = path.join(profileDir, "node_modules", PACKAGE_NAME);
const patchFile = path.join(profileDir, "cordis.patch.yml");

/** js-yaml ships with the harness; load it from there rather than adding a dep. */
async function loadYaml() {
  const candidates = [
    path.join(profileDir, "node_modules", "js-yaml", "index.js"),
    path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "js-yaml", "index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return (await import(`file://${candidate.replace(/\\/g, "/")}`)).default;
  }
  throw new Error("js-yaml not found; refusing to rewrite cordis.patch.yml without parsing it first");
}

const yaml = await loadYaml();

function stripManagedBlock(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === BEGIN) {
      skipping = true;
      continue;
    }
    if (line.trim() === END) {
      skipping = false;
      continue;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

const block = [
  BEGIN,
  "- insert:",
  `    - id: ${ROW_ID}`,
  `      name: '${PACKAGE_NAME}'`,
  END,
].join("\n");

async function listFiles(dir) {
  const { readdir } = await import("node:fs/promises");
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(path.relative(dir, full).split(path.sep).join("/"));
  }
  return out;
}

// ------------------------------------------------------------------ checks ---

if (!existsSync(path.join(sourceDir, "package.json"))) {
  throw new Error(`source does not look like the package: ${sourceDir}`);
}
const manifest = JSON.parse(await readFile(path.join(sourceDir, "package.json"), "utf8"));
if (manifest.name !== PACKAGE_NAME) {
  throw new Error(`source package is ${manifest.name}, expected ${PACKAGE_NAME}`);
}
if (!manifest.dsh?.bundle?.patch) {
  throw new Error("source package does not declare dsh.bundle.patch; it would not be installable");
}
if (!existsSync(profileDir)) {
  throw new Error(`profile not found: ${profileDir}`);
}

const original = existsSync(patchFile) ? await readFile(patchFile, "utf8") : "";
// Parse before touching anything: a patch file we cannot read is one we must not write.
if (original.trim() !== "") yaml.load(original);

const withoutBlock = stripManagedBlock(original);

if (has("--uninstall")) {
  const next = `${withoutBlock}\n`;
  console.log(`profile : ${profileName} (${profileDir})`);
  console.log(`remove  : ${path.relative(dshHome, targetDir)}`);
  console.log(`patch   : managed block removed`);
  if (has("--dry-run")) {
    console.log("dry run: nothing written");
  } else {
    if (original !== next) {
      await writeFile(`${patchFile}.bak-uninstall-${Date.now()}`, original, "utf8");
      await writeFile(patchFile, next, "utf8");
      yaml.load(await readFile(patchFile, "utf8"));
    }
    await rm(targetDir, { recursive: true, force: true });
    console.log("uninstalled");
  }
  process.exit(0);
}

// ------------------------------------------------------------------ install ---

const next = `${withoutBlock}\n\n${block}\n`;
console.log(`profile : ${profileName} (${profileDir})`);
console.log(`source  : ${sourceDir} v${manifest.version}`);
console.log(`target  : ${path.relative(dshHome, targetDir)}`);
console.log(`patch   : ${existsSync(patchFile) ? "update" : "create"} ${path.relative(dshHome, patchFile)}`);

if (has("--dry-run")) {
  console.log("dry run: nothing written");
  console.log(`--- patch file would become ---\n${next}`);
  process.exit(0);
}

// 1. files first, so the row never appears before the package it names.
await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
for (const entry of COPIED) {
  const from = path.join(sourceDir, entry);
  if (!existsSync(from)) throw new Error(`missing from source: ${entry}`);
  await cp(from, path.join(targetDir, entry), { recursive: true });
}
const copied = await listFiles(targetDir);
console.log(`copied  : ${copied.length} files`);

// 2. the patch row.
if (original !== next) {
  const backup = `${patchFile}.bak-verified-progress-${Date.now()}`;
  if (existsSync(patchFile)) await writeFile(backup, original, "utf8");
  await writeFile(patchFile, next, "utf8");
  const reparsed = yaml.load(await readFile(patchFile, "utf8"));
  if (!Array.isArray(reparsed)) throw new Error("rewritten patch file is not a YAML array; restore the backup");
  const rowPresent = reparsed.some(
    (entry) => Array.isArray(entry?.insert) && entry.insert.some((item) => item?.id === ROW_ID),
  );
  if (!rowPresent) throw new Error("rewritten patch file lost the inserted row; restore the backup");
  console.log(`backup  : ${path.basename(backup)}`);
} else {
  console.log("patch   : already up to date");
}

console.log("installed. Restart the harness to activate (a failed fiber is not retried, and the ESM cache holds the old module).");
