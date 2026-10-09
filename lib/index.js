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
 * There is deliberately no `Config` export.
 *
 * Cordis reads a plugin's `Config` as a **Standard Schema** — it calls
 * `Config["~standard"].validate(config)` and throws
 * `TypeError: Cannot read properties of undefined (reading 'validate')` for
 * anything else, which turns the whole row into a failed fiber before `apply`
 * ever runs. A plain object of field descriptors (which is what this plugin
 * originally exported) is therefore not merely ignored: it prevents the plugin
 * from loading at all.
 *
 * The plugin needs no configuration: the ledger path is derived from `DSH_HOME`
 * by `lib/state.js`, and a deployment that must relocate it can do so through a
 * profile patch. Shipping no schema keeps the promise "no runtime dependencies"
 * literally true.
 */

/**
 * @param {object} ctx cordis plugin context
 * @returns {undefined} cordis treats a non-function, non-null resolve value as
 *   an invalid effect and fails the whole fiber, so this function must not
 *   return a disposer object.
 */
export function apply(ctx) {
  // Ownership: `ctx.tools.register` returns a disposer, and returning it from
  // `apply` would be treated as this plugin's own cleanup handle. Registering
  // the disposers with `ctx.effect` keeps them tied to the fiber without
  // changing `apply`'s return value.
  ctx.effect(
    () => registerTools(ctx, {}),
    "dsh-longhorizon: verified-progress tools",
  );
  return undefined;
}
