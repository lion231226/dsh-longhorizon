# End-to-end evidence: a real model, a real verifier, a real ledger

This document records acceptance runs on a real harness with a real model, as
opposed to the scripted-verifier probe in `tools/acceptance-probe.mjs`. Both are
needed: the probe proves the harness logic deterministically and carries the
positive control; these runs prove the whole path actually works when a language
model is the verifier.

## What was run

```
# profile: lh-run (bundles: dsh-base, dsh-headless, dsh-verified-progress)
# installed the way a user installs it, straight from the published release:
dsh plugin --profile lh-run add \
  https://github.com/lion231226/dsh-verified-progress/releases/download/v0.3.1/dsh-verified-progress.tgz

# workspace: an empty directory plus one fixture file
echo -n "verified-once" > e2e-target.txt

# task text on stdin (argv mangles multi-line task text on Windows)
dsh --profile lh-run -
```

Task: *call `verified_progress_verify` exactly once* with the claim that
`e2e-target.txt` exists and contains exactly `verified-once`, and (from v0.3.1)
`guard_scope: "**"`, then print the returned summary verbatim.

Resulting ledger, run `s-session-a7f48107-...`:

```
verdict=complete  integrity=clean  contract=aligned
provider=spawn    workspaceMutated=False    evidence=4 items
```

## The desktop finding that changed the design

Running the same tool from the desktop profile — where the session's working
directory is `~/.dsh` — produced this instead, twice in a row:

```
Round 1: BLOCKED (integrity: violation, contract: unknown)
Workspace: workspace mutated (+3 ~5 -3)
```

Every changed path was harness-owned:

```
sessions/--C-Users-81521-.dsh--/…/session.v4.jsonl.zstd
storages/session_projcache/sessions/…
dsh-skill-hub.json
```

The verifier had written nothing. The guard was fingerprinted over the whole
workspace root, and in that profile the workspace root is the harness home, which
the running session writes to on every turn. The verdict was a false accusation —
and a convincing one, because it arrived in the shape of a conservative verdict.

v0.3.1 fixes this by scoping the fingerprint to what the caller declares
(`guard_scope`), requiring that scope when the workspace is the harness home,
excluding harness-owned roots only at the root, and printing
`Fingerprinted: <path>` in the result so the scope is never implicit. After the
fix, the same desktop-shaped run returns `COMPLETE … workspace unchanged`.

The acceptance probe gained a fourth scenario for exactly this case: churn
outside the scope is ignored while a real edit inside it still trips the guard.

## What the model reported

```
Round 1: COMPLETE (integrity: clean, contract: aligned)
Recorded as VERIFIED PROGRESS.
Workspace: workspace unchanged
```

## What the ledger recorded

`<DSH_HOME>/verified-progress/runs/<run-id>/ledger.jsonl` holds two records: the
`verify_started` event and the accepted round. The accepted round carries
`"verdict":"complete"`, `"integrity":"clean"`, `"contract":"aligned"`,
`"workspaceMutated":false`, `"changedPaths":[]`, `"evidenceGaps":[]`,
`"verifierProvider":"spawn"`, `"verifierError":""`.

The verifier (a `spawn` subagent that inherits no conversation context) proved
the claim by reading the file, grepping `^verified-once$`, globbing for
duplicates, and counting the characters itself. One of its evidence items,
recorded verbatim:

> `grep` for `^verified-once$` … `Found 1 match` / `Line 1: verified-once`,
> confirming the line's content is exactly `verified-once` with no
> leading/trailing whitespace or extra characters.

An earlier run of the same task recorded one honest limitation rather than
rounding it away, and it is worth quoting because it is the behaviour the design
is aiming for — the verifier reports what it could establish and names what it
could not:

> Byte-level state of the file terminator (whether a trailing newline byte
> follows the 13 text characters) is not observable with read-only,
> line-oriented tools; this does not change the text content, which is exactly
> the 13 characters required.

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
dsh plugin --profile <name> add dsh-verified-progress     # or the release tarball
echo -n "verified-once" > e2e-target.txt
printf '%s\n' "Call verified_progress_verify exactly once, claiming e2e-target.txt contains exactly verified-once, then print the summary verbatim." \
  | dsh --profile <name> -
cat "$DSH_HOME/verified-progress/runs/"*/ledger.jsonl
```

A `COMPLETE` round in the ledger means an independent verifier established the
claim against the workspace. An `INCOMPLETE` round means it did not — and the
reason is in the ledger either way.
