/**
 * dsh-longhorizon — the independent verifier episode.
 *
 * The whole point of this plugin is that the thing which certifies a claim is
 * not the thing which made it. So the verifier:
 *
 *  - runs as a **separate subagent** whose provider does not inherit the
 *    parent's context, so it cannot see the executor's reasoning, its
 *    justifications, or its earlier mistakes;
 *  - is told to inspect **the workspace**, not the conversation — read files,
 *    run the checks, quote what it found;
 *  - answers with a fixed three-line control block that the harness parses
 *    (see `core/verdict.js`), so "done" is a machine-checkable claim;
 *  - is restricted to a read-only tool set, and the workspace is fingerprinted
 *    before and after the episode so a verifier that writes anyway is caught.
 *
 * The verifier deliberately receives no ledger history and no plan. Its only
 * input is the claim under test plus what the executor said should be true.
 */

import { VERDICT_CONTRACT } from "./core/verdict.js";

/**
 * Tools the verifier may use. Read-only by construction: no `write`, no `edit`,
 * no `pwsh` (a shell could write), no subagent spawning.
 *
 * Every name here must exist in the host's global tool registry — the filter is
 * applied by `tools.restrict()`, which refuses the whole restriction (and
 * therefore the whole verification episode) when a name is unknown. The list
 * below was corrected against a live harness, which reported:
 *   `tools.restrict() names unknown global tools "list", "str_replace_editor_view"`
 * A verifier that cannot be started produces no verdict, so a single stale name
 * silently downgrades every round to `incomplete`.
 */
export const VERIFIER_TOOLS = ["read", "glob", "grep", "read_image"];

/** Persona: keeps the child from drifting into "helping". */
export const VERIFIER_PERSONA =
  "You are an independent verifier. You never improve, fix, or finish the work you inspect. " +
  "You report what the workspace actually shows, including when that contradicts the claim.";

/**
 * Build the verifier's prompt.
 *
 * @param {object} args
 * @param {string} args.claim what the executor asserted is done
 * @param {string} [args.evidenceHint] paths/commands the executor says prove it
 * @param {string} [args.acceptance] the acceptance criteria the claim is judged against
 * @param {string} args.workspace absolute workspace root
 * @returns {string}
 */
export function buildVerifierPrompt({ claim, evidenceHint, acceptance, workspace }) {
  const lines = [
    "You are verifying one claim about a workspace. You did not write this code and you have no",
    "stake in it being finished.",
    "",
    `Workspace root: ${workspace}`,
    "",
    "CLAIM UNDER TEST:",
    claim.trim() || "(the executor supplied no claim text)",
  ];

  if (acceptance && acceptance.trim() !== "") {
    lines.push("", "ACCEPTANCE CRITERIA (the claim is only true if these hold):", acceptance.trim());
  }
  if (evidenceHint && evidenceHint.trim() !== "") {
    lines.push(
      "",
      "WHAT THE EXECUTOR SAYS PROVES IT (treat this as a pointer, not as evidence):",
      evidenceHint.trim(),
    );
  }

  lines.push(
    "",
    "DO THIS:",
    "1. Open the files that the claim is about. Read them.",
    "2. Run the check that would fail if the claim were false, when you can do so by reading files.",
    "   You have read-only tools: you cannot execute commands, and you must not change anything.",
    "3. Compare what you found against the acceptance criteria, item by item.",
    "4. Report honestly. An unfinished claim reported as unfinished is a good result; a finished",
    "   claim reported as unfinished is a false alarm the next round will spend time on.",
    "",
    "Do NOT modify, create, or delete any file. Do NOT describe what you would fix. You are not the",
    "author of this work and your job ends with the verdict.",
    "",
    "ANSWER EXACTLY THIS SHAPE, with the three control lines first and verbatim:",
    "",
    VERDICT_CONTRACT,
    "",
    "Then, under them, these sections:",
    "",
    "Evidence: the paths you opened and what they showed (quote the decisive lines).",
    "Missing: what is absent or unproven, one item per line. Write `None` if nothing is missing.",
    "Task state: one paragraph describing what is now verified to be true, written so a fresh agent",
    "could continue from it without reading this conversation.",
    "",
    "Rules for the control lines:",
    "- `Status: complete` only if the acceptance criteria are met by what you actually read.",
    "- `Integrity: clean` only if the work inspected is genuine; use `suspect` when something looks",
    "  staged for the check, and `violation` when evidence was fabricated or the claim is false.",
    "- `Contract audit: aligned` only if the delivered work matches the stated criteria; use",
    "  `needs_revision` when it does something else, and `unknown` when you could not tell.",
    "- Never write `complete` together with a non-`clean` integrity or a non-`aligned` contract.",
  );

  return lines.join("\n");
}

/**
 * Pick a subagent provider that cannot see the parent's context.
 *
 * `inheritsParentContext !== true` is the load-bearing condition: a forked child
 * would inherit the executor's reasoning and could not independently judge it.
 *
 * @param {object} subagents the `ctx.subagents` service
 * @returns {string | null}
 */
export function selectVerifierProvider(subagents) {
  const names = typeof subagents?.list === "function" ? subagents.list() : [];
  const isolated = (name) => {
    const provider = typeof subagents.getProvider === "function" ? subagents.getProvider(name) : undefined;
    return provider?.inheritsParentContext !== true;
  };
  if (names.includes("spawn") && isolated("spawn")) return "spawn";
  return names.find(isolated) ?? null;
}

/**
 * Run one verification episode.
 *
 * @param {object} args
 * @param {object} args.subagents
 * @param {object} args.parent the calling Agent (from the tool's `exec.agent`)
 * @param {AbortSignal} args.signal
 * @param {string} args.prompt
 * @returns {Promise<{status: "ok", text: string, provider: string, runId: string} |
 *                   {status: "error", reason: string, provider: string | null}>}
 */
export async function runVerificationEpisode({ subagents, parent, signal, prompt }) {
  const provider = selectVerifierProvider(subagents);
  if (!provider) {
    return {
      status: "error",
      provider: null,
      reason:
        "no subagent provider with independent context is available; verification cannot be performed",
    };
  }

  let run;
  try {
    run = await subagents.start(provider, {
      label: "longhorizon-verify",
      prompt: [{ type: "text", text: prompt }],
      parent,
      signal,
      maxDepth: 1,
      toolFilter: { allow: [...VERIFIER_TOOLS] },
      persona: VERIFIER_PERSONA,
    });

    // `result` never rejects on a business failure — the outcome is in
    // `stopReason` — so a verifier that refuses or dies is read, not thrown.
    const result = await run.result;
    const text = (result?.output ?? [])
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (result?.stopReason !== "completed") {
      return {
        status: "error",
        provider,
        reason: `verifier stopped with ${result?.stopReason ?? "an unknown reason"}`,
      };
    }
    if (text === "") {
      return { status: "error", provider, reason: "verifier returned no text" };
    }
    return { status: "ok", text, provider, runId: String(run.id ?? "") };
  } catch (error) {
    return {
      status: "error",
      provider,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Subagent slots are a bounded resource (`maxActiveSubagents`, 8-10 by
    // default) and are only returned by disposing the run. Leaking one per
    // verification would make the plugin work for the first few rounds and then
    // silently fail to start any further verifier — the exact silent,
    // delayed failure this project exists to eliminate.
    if (run && typeof run.dispose === "function") {
      try {
        await run.dispose();
      } catch {
        // A failed dispose must not replace the verdict we already computed.
      }
    }
  }
}
