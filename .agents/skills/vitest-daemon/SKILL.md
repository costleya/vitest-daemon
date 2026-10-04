---
name: vitest-daemon
description: Use vitest-daemon whenever agents need Vitest watch mode, including solo and shared workflows. Use ordinary Vitest only for finite test runs.
---

# Vitest daemon

Run `vitest-daemon` from the worktree being tested.

Requires Node.js 24 or newer and Vitest `^5.0.3` installed in that worktree. The
daemon loads the worktree's `vitest/node` API.

## Choose the workflow

- Use `vitest-daemon` for every Vitest watch, whether one agent or several agents consume its results.
- Use the repository's ordinary Vitest command only for a finite test run.
- Treat a passing daemon snapshot as a replacement for a duplicate plain Vitest run only when the repository's verification workflow permits it. It does not replace coverage or other required checks.

## Own the lifecycle

The agent that starts a daemon owns its lifecycle. In shared-agent work, the coordinating agent starts it before assigning work, gives participating agents its exact name, keeps it alive through relevant edits, and stops that exact name after the work is integrated.

Participating agents may inspect a supplied daemon but must not start, stop, or reconfigure it unless lifecycle ownership was explicitly delegated to them.

Choose a short, task-relevant name. Names may contain letters, numbers, `.`, `_`, and `-`, up to 64 characters. The same name can safely exist in different worktrees because the canonical worktree path is part of its identity.

```sh
vitest-daemon start unit -- --project unit
```

Vitest arguments are fixed for the lifetime of that name. To change projects or filters, the lifecycle owner must stop the daemon and start it again with new arguments. File changes are the rerun mechanism.

## Inspect results

Use each command for its distinct signal:

```sh
vitest-daemon status unit
vitest-daemon snapshot unit
vitest-daemon output unit
```

- `status` reports daemon availability as `starting`, `running`, or `stopping`; it does not report test success.
- `snapshot` emits one JSON value. `checking` is transient; `passed` or `failed` includes counts, failures, and unhandled errors. After a relevant edit, retry a `checking` snapshot only within a bounded deadline.
- `output` emits bounded raw Vitest stdout and stderr. Read it when the structured failure lacks enough diagnostic context, not as the primary state check.

Do not add a `--json` flag to `snapshot`; its output is already JSON.

## Stop safely

After the last relevant inspection, stop the exact daemon owned by the task:

```sh
vitest-daemon stop unit
```

Run `vitest-daemon status` first when ownership is uncertain. Reserve `vitest-daemon stop --all` for an intentional whole-worktree cleanup after reviewing the listed names; do not use broad process-name termination.

If `vitest-daemon` is unavailable or the target worktree does not provide a compatible Vitest installation, report that boundary. Do not substitute another watch command; use ordinary Vitest only when a finite run satisfies the task.
