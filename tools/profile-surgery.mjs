/**
 * Profile surgery for the web and desktop DSH profiles.
 *
 * Two jobs, both driven by what the GUI actually reads:
 *
 *  1. `web` — remove the six bundles the runtime skips as peer-incompatible.
 *     Removal has to touch all three places they appear in (dependencies,
 *     dsh.profile.bundles, node_modules), because leaving any one behind keeps
 *     either the skip warning or a resolvable-but-dead package.
 *
 *  2. `desktop` — list locally-mounted plugins in `dependencies`. The 应用 →
 *     插件 page enumerates `dependencies`, so a plugin mounted the low-risk way
 *     (package directory + a `cordis.patch.yml` insert row, which is how
 *     dsh-peak-hours has always worked here) never appears there, even though
 *     the 设置 → 内置插件 page — which reads the composed rows — shows it.
 *     A `file:` spec pointing at the already-populated directory makes the two
 *     pages agree without re-installing anything.
 *
 * Every write is preceded by a parse and followed by a re-parse; a file that
 * fails either check is never left on disk.
 *
 * Usage: node tools/profile-surgery.mjs [--dry-run]
 */

import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DRY = process.argv.includes("--dry-run");
const DSH_HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
const PROFILES = path.join(DSH_HOME, "profiles");

const SKIPPED = [
  "aegis",
  "@dsh-external/workflow",
  "dsh-builtin-browser",
  "dsh-win32",
  "dsh-find-plugin",
  "@changfenhuang/dsh-genui",
];

/** Plugins mounted by directory + patch row, which the 插件 page cannot see. */
const MOUNTED = ["dsh-verified-progress", "dsh-peak-hours"];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function readJson(file) {
  return readFile(file, "utf8").then((text) => JSON.parse(text));
}

async function writeJsonChecked(file, value) {
  // Parse what we are about to replace, refuse to write if it is unreadable.
  JSON.parse(await readFile(file, "utf8"));
  const text = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(text);
  if (DRY) return false;
  await writeFile(`${file}.bak-surgery-${stamp}`, await readFile(file, "utf8"));
  await writeFile(file, text, "utf8");
  JSON.parse(await readFile(file, "utf8"));
  return true;
}

// ------------------------------------------------------------- web cleanup ---

async function cleanWeb() {
  const dir = path.join(PROFILES, "web");
  const pkgFile = path.join(dir, "package.json");
  const pkg = await readJson(pkgFile);

  const removedDeps = [];
  for (const name of SKIPPED) {
    if (pkg.dependencies && name in pkg.dependencies) {
      delete pkg.dependencies[name];
      removedDeps.push(name);
    }
  }
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const keptBundles = bundles.filter((name) => !SKIPPED.includes(name));
  const removedBundles = bundles.filter((name) => SKIPPED.includes(name));
  if (pkg.dsh?.profile) pkg.dsh.profile.bundles = keptBundles;

  console.log("[web] dependencies removed :", removedDeps.join(", ") || "(none)");
  console.log("[web] bundles removed      :", removedBundles.join(", ") || "(none)");
  console.log("[web] bundles kept         :", keptBundles.length);

  const written = await writeJsonChecked(pkgFile, pkg);
  console.log(written ? "[web] package.json written" : "[web] dry run, nothing written");

  // Park the packages instead of deleting them, so this is reversible.
  const park = path.join(dir, ".removed-bundles", stamp);
  for (const name of SKIPPED) {
    const from = path.join(dir, "node_modules", name);
    if (!existsSync(from)) {
      console.log(`[web] node_modules/${name}: absent`);
      continue;
    }
    if (DRY) {
      console.log(`[web] node_modules/${name}: would park`);
      continue;
    }
    await mkdir(path.dirname(path.join(park, name)), { recursive: true });
    try {
      await rename(from, path.join(park, name));
      console.log(`[web] node_modules/${name}: parked`);
    } catch (error) {
      // A rename can fail across a junction; fall back to a copy+remove.
      await cp(from, path.join(park, name), { recursive: true });
      await rm(from, { recursive: true, force: true });
      console.log(`[web] node_modules/${name}: copied out and removed (${error.code})`);
    }
  }
  if (!DRY && existsSync(park)) console.log(`[web] parked under ${path.relative(DSH_HOME, park)}`);
}

// --------------------------------------------------- desktop dependencies ---

async function listDesktop() {
  const dir = path.join(PROFILES, "desktop");
  const pkgFile = path.join(dir, "package.json");
  const pkg = await readJson(pkgFile);
  pkg.dependencies ??= {};

  const added = [];
  for (const name of MOUNTED) {
    const mounted = path.join(dir, "node_modules", name);
    if (!existsSync(path.join(mounted, "package.json"))) {
      console.log(`[desktop] ${name}: not mounted, skipped`);
      continue;
    }
    if (pkg.dependencies[name] !== undefined) {
      console.log(`[desktop] ${name}: already listed as ${pkg.dependencies[name]}`);
      continue;
    }
    // `file:` rather than `link:`: the desktop profile resolves with pnpm's
    // hoisted linker, which materialises a file: dependency as a plain copy in
    // node_modules — the shape this plugin is already installed in. `link:`
    // would create a symlink instead and change how the row resolves.
    const spec = `file:node_modules/${name}`;
    pkg.dependencies[name] = spec;
    added.push(`${name} -> ${spec}`);
  }

  if (added.length === 0) {
    console.log("[desktop] nothing to add");
    return;
  }
  console.log("[desktop] adding:", added.join(", "));
  const written = await writeJsonChecked(pkgFile, pkg);
  console.log(written ? "[desktop] package.json written" : "[desktop] dry run, nothing written");
}

await cleanWeb();
console.log();
await listDesktop();
