/**
 * dsh-longhorizon — where a run's state lives.
 *
 * State is intentionally NOT stored in the user's project. Everything the plugin
 * remembers lives under the harness home, so a repository stays clean and a
 * reviewer can see at a glance that the ledger is harness bookkeeping rather
 * than task content.
 */

import path from "node:path";

import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

import { deriveRunId } from "./core/ledger.js";

/** Plugin-owned directory inside the harness home. */
export const STATE_DIR_NAME = "longhorizon";

/**
 * @param {{ dshHome?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {string} absolute path of the plugin's state root
 */
export function stateRoot(options = {}) {
  const home = options.dshHome ?? resolveDshHome(undefined, options.env ?? process.env);
  return path.join(home, STATE_DIR_NAME);
}

/**
 * Resolve the workspace this call is about.
 *
 * `agent.session.header.cwd` is the harness's own record of where the session
 * was started, so it is preferred over the process cwd: the two differ whenever
 * the harness was launched from elsewhere.
 *
 * @param {{ session?: { header?: { cwd?: string } } } | undefined} agent
 * @returns {string}
 */
export function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd;
  if (typeof cwd === "string" && cwd.trim() !== "") return cwd;
  return process.cwd();
}

/**
 * @param {{ stateDir?: string, agent?: object, sessionId?: string }} args
 */
export function runContext({ stateDir, agent, sessionId }) {
  const workspace = workspaceOf(agent);
  const id = sessionId ?? agent?.session?.header?.id;
  return {
    stateDir: stateDir ?? stateRoot(),
    workspace,
    runId: deriveRunId({ workspace, sessionId: id }),
  };
}
