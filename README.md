# dsh-longhorizon

**Verified-progress ledger for long-horizon work in DeepSeek Harness.**

A long-running task fails in a specific way: the agent reports progress it cannot
prove, the report enters the transcript, and the next turn builds on a claim that
was never checked. Nothing downstream can tell a verified step from an optimistic
one, so the error compounds until the final answer is confidently wrong.

This plugin adds the missing check. When the agent claims a step is done, an
**independent verifier with a fresh context** inspects the real workspace, returns
a structured verdict, and only then does the step enter a durable ledger. A
rejected step stays in the ledger as *evidence* — it is never promoted to
progress.

```
claim ──▶ independent verification ──▶ verdict
                                        │
                        complete + clean + aligned ──▶ ledger (progress)
                                        │
                                    anything else ──▶ ledger (evidence only)
```

## What it does

Three mechanisms, each answering one failure mode.

**1. Independent verification instead of self-report.** The verifier is a
separate subagent that inherits no conversation context. It reads the files,
runs the checks, and answers with three control lines:

```
Status: complete | incomplete | blocked
Integrity: clean | suspect | violation
Contract audit: aligned | unknown | needs_revision | invalid
```

**2. A hard downgrade invariant.** A claim cannot be `complete` while the audit
is dirty:

```
integrity === "violation" || contract !== "aligned"  ⟹  status !== "complete"
```

This is enforced in code, not requested in a prompt. A verifier that omits a
control line degrades conservatively — an unstated integrity is read as
`suspect`, never as `clean` — because a placeholder must never be the thing that
certifies work as done.

**3. A durable verified-progress ledger.** Accepted steps are appended to
`ledger.jsonl` (one JSON object per line, fsync'd per append) with a last-wins
projection in `state.json`. A crashed process, a compacted context, or a fresh
session can reopen the run and answer: what is verified, what was rejected and
why, and what is left.

**Mutation guard.** The verifier is supposed to observe, never to write. The
workspace is fingerprinted (size + mtime for every file, plus SHA-256 for files
under the hash limit) immediately before and after each verification. If
anything changed, the audit's own findings are voided and the round is recorded
as `blocked` / `violation`.

## Tools

| Tool | Purpose |
|---|---|
| `longhorizon_verify` | Verify one claimed step against the workspace; records the verdict in the ledger. |
| `longhorizon_ledger` | Read back verified progress, rejected claims, and what remains. |
| `longhorizon_state` | Current run state: verified rounds, pending claims, open items. |

## Install

```sh
dsh plugin --profile web add dsh-longhorizon
```

Then restart the harness. No build step: the package ships plain ESM and has no
runtime dependencies.

## Storage

Everything lives under the harness state directory, not in your project:

```
<state>/longhorizon/runs/<runId>/ledger.jsonl
<state>/longhorizon/runs/<runId>/state.json
```

`<runId>` is derived from the session id when there is one, otherwise from a hash
of the working directory, so reopening the same session reopens the same run.

## Design limits — read these

- **The verifier is a separate agent, not a separate process.** It cannot see the
  executor's conversation, which is what makes it independent, but it runs inside
  the harness and is subject to the same permissions.
- **The mutation guard is a correctness tool, not a security boundary.** It
  compares file fingerprints; it does not defend against a local attacker, and it
  is not a sandbox.
- **Unhashed large files are reported as an evidence gap.** Files above the hash
  limit are compared by size and mtime, and the snapshot says so rather than
  claiming a comparison it did not make.
- **Verification costs tokens.** Each verified step adds one verifier episode.
  The ledger is what you get for it; if your task is a single short turn, you do
  not need this plugin.

## Why this exists

The loop design is ported from [LongHorizon-Harness](https://github.com/AMAP-ML/LongHorizon-Harness)
(AMAP-ML, MIT) — manager/executor/auditor rounds, a durable round ledger, and an
auditor that cannot certify a dirty result.

That project is a Python orchestrator that wraps an agent CLI. It does not run on
Windows: its persistent layer requires `os.O_NOFOLLOW`, `os.O_DIRECTORY` and
`supports_dir_fd` (all absent on win32) and it shells out with POSIX
`VAR=value cmd` templates. It also, by its own design, drives one agent CLI per
role episode — so on DeepSeek Harness it can only read the final answer of each
`dsh --profile headless` run, not the intermediate tool events.

This plugin takes the parts that carry the value — independent verification, the
downgrade invariant, the verified-state ledger, the mutation guard — and
implements them natively in the harness, where the events are available and no
POSIX-only primitive is needed.

## License

MIT
