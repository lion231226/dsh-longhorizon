/**
 * dsh-longhorizon — verdict grammar and downgrade invariant.
 *
 * The verifier is an independent agent whose only job is to decide whether a
 * claim about the workspace is true. Its answer is free text, because that is
 * what an LLM reliably produces; the harness therefore needs a *small, strict*
 * grammar to turn that text into something machine-checkable, plus one
 * invariant that the model cannot talk its way out of.
 *
 * Grammar — three control lines, one per concept:
 *
 *     Status: complete | incomplete | blocked
 *     Integrity: clean | suspect | violation
 *     Contract audit: aligned | unknown | needs_revision | invalid
 *
 * The invariant (ported from LongHorizon-Harness's auditor, which is the only
 * part of that project that survives on Windows):
 *
 *     integrity === "violation" || contract !== "aligned"  =>  status !== "complete"
 *
 * A claim cannot be `complete` while the audit is dirty. That is the whole
 * anti-self-report mechanism: the executing agent may *claim* anything, but the
 * claim is only recorded as progress once an independent verifier's own control
 * lines say the workspace agrees. Rejected results are kept as evidence — they
 * are never promoted to progress.
 *
 * Missing or unparseable lines degrade in the conservative direction: an
 * unstated integrity is read as `suspect`, not `clean`, so a verifier that
 * forgot to answer cannot accidentally certify work.
 */

/** @typedef {"complete" | "incomplete" | "blocked"} VerdictStatus */
/** @typedef {"clean" | "suspect" | "violation"} IntegrityStatus */
/** @typedef {"aligned" | "unknown" | "needs_revision" | "invalid"} ContractStatus */

export const VERDICT_STATUSES = ["complete", "incomplete", "blocked"];
export const INTEGRITY_STATUSES = ["clean", "suspect", "violation"];
export const CONTRACT_STATUSES = ["aligned", "unknown", "needs_revision", "invalid"];

/** A line like `Status: complete`, optionally bold or bulleted, EN or ZH. */
const CONTROL_LINE_SOURCES = {
  status: String.raw`(?:status|状态)`,
  integrity: String.raw`(?:integrity|完整性)`,
  contract: String.raw`(?:contract(?:\s*[_\s-]*audit)?|契约审计)`,
};

const CONTROL_LINE_PATTERNS = {
  status: new RegExp(
    String.raw`^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?[ \t]*${CONTROL_LINE_SOURCES.status}[ \t]*[:：][ \t]*` +
      String.raw`(complete|incomplete|blocked|完成|未完成|阻塞)[ \t]*(?:\*\*)?[ \t]*$`,
    "im",
  ),
  integrity: new RegExp(
    String.raw`^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?[ \t]*${CONTROL_LINE_SOURCES.integrity}[ \t]*[:：][ \t]*` +
      String.raw`(clean|suspect|violation)[ \t]*(?:\*\*)?[ \t]*$`,
    "im",
  ),
  contract: new RegExp(
    String.raw`^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?[ \t]*${CONTROL_LINE_SOURCES.contract}[ \t]*[:：][ \t]*` +
      String.raw`(aligned|unknown|needs[_\s-]*revision|invalid|对齐|未知|需要?修订|无效)[ \t]*(?:\*\*)?[ \t]*$`,
    "im",
  ),
};

const STATUS_ALIASES = {
  complete: "complete",
  完成: "complete",
  incomplete: "incomplete",
  未完成: "incomplete",
  blocked: "blocked",
  阻塞: "blocked",
};

const CONTRACT_ALIASES = {
  aligned: "aligned",
  对齐: "aligned",
  unknown: "unknown",
  未知: "unknown",
  needs_revision: "needs_revision",
  需修订: "needs_revision",
  需要修订: "needs_revision",
  invalid: "invalid",
  无效: "invalid",
};

function matchControl(text, key) {
  const match = CONTROL_LINE_PATTERNS[key].exec(text ?? "");
  return match ? match[1] : null;
}

/**
 * Parse the three control lines out of a verifier's free-text report.
 *
 * @param {string} text
 * @returns {{status: VerdictStatus|null, integrity: IntegrityStatus|null, contract: ContractStatus|null,
 *            stated: {status: boolean, integrity: boolean, contract: boolean}}}
 */
export function parseVerdict(text) {
  const rawStatus = matchControl(text, "status");
  const rawIntegrity = matchControl(text, "integrity");
  const rawContract = matchControl(text, "contract");

  const status = rawStatus ? STATUS_ALIASES[String(rawStatus).toLowerCase()] ?? null : null;

  const integrity = rawIntegrity ? String(rawIntegrity).toLowerCase() : null;

  let contract = null;
  if (rawContract) {
    const normalized = String(rawContract).toLowerCase().replace(/[\s-]+/g, "_");
    contract = CONTRACT_ALIASES[normalized] ?? CONTRACT_ALIASES[String(rawContract)] ?? null;
  }

  return {
    status,
    integrity: INTEGRITY_STATUSES.includes(integrity) ? integrity : null,
    contract: CONTRACT_STATUSES.includes(contract) ? contract : null,
    stated: {
      status: Boolean(status),
      integrity: Boolean(integrity),
      contract: Boolean(contract),
    },
  };
}

/**
 * Apply the downgrade invariant to a parsed verdict.
 *
 * Conservative defaults are deliberate:
 *  - an unstated status is `incomplete` (never `complete`);
 *  - an unstated integrity is `suspect` (never `clean`).
 *
 * @param {ReturnType<typeof parseVerdict>} parsed
 * @param {{ changedPaths?: string[], verifierMutatedWorkspace?: boolean, reason?: string }} [context]
 * @returns {{status: VerdictStatus, integrity: IntegrityStatus, contract: ContractStatus,
 *            downgraded: boolean, downgradeReasons: string[], evidenceOnly: boolean}}
 */
export function enforceVerdict(parsed, context = {}) {
  const downgradeReasons = [];

  let status = parsed.status ?? "incomplete";
  let integrity = parsed.integrity ?? "suspect";
  let contract = parsed.contract ?? "unknown";

  if (!parsed.stated.status) downgradeReasons.push("verifier did not state a Status line");
  if (!parsed.stated.integrity) downgradeReasons.push("verifier did not state an Integrity line");
  if (!parsed.stated.contract) downgradeReasons.push("verifier did not state a Contract audit line");

  // The verifier is supposed to observe, never mutate. A mutation is proof that
  // the "read-only" side of the audit was not actually read-only, so its own
  // findings cannot be trusted as evidence about the executor.
  if (context.verifierMutatedWorkspace) {
    integrity = "violation";
    contract = "unknown";
    status = "blocked";
    downgradeReasons.push(
      "verifier changed workspace files during a read-only audit; its findings are void",
    );
  }

  if (integrity === "violation") {
    downgradeReasons.push("integrity reported as violation");
  } else if (contract !== "aligned") {
    downgradeReasons.push(`contract audit is ${contract}, not aligned`);
  }

  // A verdict that failed to answer the questions is not a verdict. This is
  // deliberately separate from the invariant below: `suspect` and `unknown` are
  // conservative placeholders, not findings, and a placeholder must never be
  // the thing that certifies work as done. The downgrade flag is set here too
  // so callers cannot mistake a defaulted verdict for a clean pass.
  let downgraded = false;
  if (
    status === "complete" &&
    (!parsed.stated.status || !parsed.stated.integrity || !parsed.stated.contract)
  ) {
    status = "incomplete";
    downgraded = true;
  }

  // The invariant, applied last so nothing above can leave a dirty `complete`.
  if (status === "complete" && (integrity === "violation" || contract !== "aligned")) {
    status = "incomplete";
    downgraded = true;
  }

  return {
    status,
    integrity,
    contract,
    downgraded,
    downgradeReasons,
    // Only a clean, aligned, complete verdict may be promoted to progress.
    evidenceOnly: status !== "complete",
  };
}

/**
 * One-call convenience: parse then enforce.
 *
 * @param {string} text
 * @param {{ changedPaths?: string[], verifierMutatedWorkspace?: boolean }} [context]
 */
export function judge(text, context = {}) {
  const parsed = parseVerdict(text);
  const enforced = enforceVerdict(parsed, context);
  return { ...parsed, ...enforced };
}

/** The control block the verifier prompt must ask for, verbatim. */
export const VERDICT_CONTRACT = [
  "Status: complete | incomplete | blocked",
  "Integrity: clean | suspect | violation",
  "Contract audit: aligned | unknown | needs_revision | invalid",
].join("\n");
