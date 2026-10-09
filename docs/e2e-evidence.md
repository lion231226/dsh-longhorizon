# End-to-end evidence: a real model, a real verifier, a real ledger

This document records one acceptance run on a real harness with a real model, as
opposed to the scripted-verifier probe in `tools/acceptance-probe.mjs`. Both are
needed: the probe proves the harness logic deterministically and carries the
positive control; this run proves the whole path actually works when a language
model is the verifier.

## What was run

```
# profile: lh-run (bundles: dsh-base, dsh-headless, dsh-longhorizon)
# plugin installed the way a user installs it: dsh plugin --profile lh-run add <tarball>
# workspace: an empty directory plus one fixture file
echo -n "verified-once" > e2e-target.txt

dsh --profile lh-run -            # task text on stdin
```

Task: *call `longhorizon_verify` exactly once* with the claim that
`e2e-target.txt` exists and contains exactly `verified-once`, then print the
returned summary verbatim.

## What the model reported

```
Round 1: COMPLETE (integrity: clean, contract: aligned)
Recorded as VERIFIED PROGRESS.
Workspace: workspace unchanged
```

## What the ledger recorded

`<DSH_HOME>/longhorizon/runs/s-session-419933ee-.../ledger.jsonl`, two records —
the `verify_started` event and the accepted round. The accepted round carries
`"verdict":"complete","integrity":"clean","contract":"aligned"`,
`"workspaceMutated":false`, `"changedPaths":[]`, `"evidenceGaps":[]`,
`"verifierProvider":"spawn"`, `"verifierError":""`.

The verifier (a `spawn` subagent that inherits no conversation context) proved
the claim by reading the file, grepping `^verified-once$`, globbing for
duplicates, and counting the characters itself. Its six evidence items are
recorded verbatim in the ledger, including this one:

> `grep` for `^verified-once$` … `Found 1 match` / `Line 1: verified-once`,
> confirming the line's content is exactly `verified-once` with no
> leading/trailing whitespace or extra characters.

It also recorded one honest limitation rather than rounding it away:

> Byte-level state of the file terminator (whether a trailing newline byte
> follows the 13 text characters) is not observable with read-only,
> line-oriented tools; this does not change the text content, which is exactly
> the 13 characters required.

That last item is the behaviour the design is aiming for: the verifier reports
what it could establish and names what it could not.

## What this run caught

The first attempt against this same task **failed**, and that failure is the most
useful thing in this document. The verifier episode died with:

```
tools.restrict() names unknown global tools "list", "str_replace_editor_view";
known global tools: create_goal, edit, exit_plan_mode, get_goal, glob, grep, ...
```

The tool filter had been written against guessed tool names. Because
`tools.restrict()` rejects the whole restriction when any name is unknown, no
verifier could start, so the round was correctly recorded as `INCOMPLETE` and
`evidence only` — the claim did **not** become progress. The failure was silent
in the sense that nothing crashed; it was visible only because the round was
downgraded and the reason was written into the ledger.

Two fixes came out of it:

1. `VERIFIER_TOOLS` is now `read`, `glob`, `grep`, `read_image`, and a test
   asserts every name exists in the host registry and that no write-capable tool
   is ever granted.
2. That test is a structural constraint rather than a comment, because the
   failure mode it guards against degrades *every* round while looking like a
   conservative verdict.

The second fix was a schema defect: the tool declared its output as an open
object with no properties, so the rendered content reached the model but the
declared fields did not. The output schema now declares its fields explicitly,
which is why the run above could read a verdict instead of a bare summary.

## Reproducing

```sh
dsh plugin --profile <name> add dsh-longhorizon     # or the release tarball
echo -n "verified-once" > e2e-target.txt
printf '%s\n' "Call longhorizon_verify exactly once, claiming e2e-target.txt contains exactly verified-once, then print the summary verbatim." \
  | dsh --profile <name> -
cat "$DSH_HOME/longhorizon/runs/"*/ledger.jsonl
```

A `COMPLETE` round in the ledger means an independent verifier established the
claim against the workspace. An `INCOMPLETE` round means it did not — and the
reason is in the ledger either way.
