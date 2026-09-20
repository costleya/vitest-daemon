# vitest-daemon

`vitest-daemon` runs named Vitest watch processes independently of the terminal
that launched them. A daemon is scoped by its canonical worktree path and name,
so agents in separate worktrees never share a watcher accidentally.

Requires Node.js 24 or newer and Vitest 4.1.

## Install globally from this checkout

```sh
pnpm install
pnpm build
pnpm link --global
```

The global CLI loads `vitest/node` from the target worktree. Vitest remains a
dependency of the project being watched, not of the global installation.

## Commands

Run commands from the worktree they belong to, or pass `--root <path>`.

```sh
# Copy the bundled agent skill into the current worktree
vitest-daemon install

# Parent agent: start and stop lifecycle
vitest-daemon start unit -- --project unit
vitest-daemon stop unit
vitest-daemon stop --all

# Any agent: inspect the watcher
vitest-daemon status unit
vitest-daemon status
vitest-daemon snapshot unit
vitest-daemon output unit
```

`status` reports only whether the daemon is starting, running, or stopping.

`stop` waits for the daemon process to exit before reporting success. Shutdown
has a five-second deadline, including Vitest startup and `close()`. While it
closes, the daemon remains discoverable as `stopping`. If shutdown hangs, the
daemon exits to release its in-process servers. Discovery retains the PID and
a unique launch identity until the CLI confirms exit, allowing a later `stop`
to recover an unreachable daemon. On macOS and Linux, this fallback verifies
the process command before forcefully terminating the PID. If identity cannot
be verified (including legacy records without a PID), the CLI reports an error
instead of claiming a successful stop.
`snapshot` reports Vitest's current structured checking, passed, or failed
state. Both commands always write one JSON value followed by a newline.
`output` writes the bounded stdout/stderr captured from Vitest without a
heading, JSON wrapper, ANSI stripping, or an added newline.

Each watcher name has fixed Vitest arguments. Stop it and start it again to use
different filters. File changes are the only rerun mechanism.
