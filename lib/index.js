/**
 * dsh-longhorizon — cordis plugin entry point.
 *
 * A verified-progress ledger for long-horizon work: an independent verifier
 * with a fresh context certifies each claimed step against the real workspace,
 * a hard invariant refuses to record a dirty result as progress, and the
 * accepted rounds survive a crash, a compaction, or a new session.
 *
 * The plugin is a thin host layer. All of the decision logic lives in
 * `lib/core/` and has no harness dependency, which is what makes it testable:
 * see `test/core.test.mjs`.
 */

import { registerTools } from "./tools.js";

export const name = "dsh-longhorizon";

/** Services this plugin needs before it can register anything. */
export const inject = ["tools", "subagents"];

/**
 * Plugin configuration.
 *
 * `stateDir` overrides where the ledger is written. The default is
 * `<DSH_HOME>/longhorizon`, so state never lands in the user's project.
 *
 * @type {{ stateDir?: string }}
 */
export const Config = {
  stateDir: { type: "string", description: "Override the ledger's state directory." },
};

/**
 * @param {object} ctx cordis plugin context
 * @param {{ stateDir?: string }} [config]
 * @returns {undefined} cordis treats a non-function, non-null resolve value as
 *   an invalid effect and fails the whole fiber, so this function must not
 *   return a disposer object.
 */
export function apply(ctx, config = {}) {
  const options = {};
  if (typeof config.stateDir === "string" && config.stateDir.trim() !== "") {
    options.stateDir = config.stateDir;
  }
  // Ownership: `ctx.tools.register` returns a disposer, and returning it from
  // `apply` would be treated as this plugin's own cleanup handle. Registering
  // the disposers with `ctx.effect` keeps them tied to the fiber without
  // changing `apply`'s return value.
  ctx.effect(
    () => registerTools(ctx, options),
    "dsh-longhorizon: verified-progress tools",
  );
  return undefined;
}
