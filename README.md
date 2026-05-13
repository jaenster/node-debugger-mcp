# node-debugger-mcp

An MCP server that gives Claude a real Node.js debugger — breakpoints, stepping, scope inspection, eval, watches, source-map-aware BPs, child-process and worker-thread auto-attach, and a few things even IDEs don't usually expose like discovering every live `AsyncLocalStorage` instance.

Built because Claude couldn't do any of that. Speaks the V8 Inspector Protocol (the same one Chrome DevTools and JetBrains use), shipped as a single bundled JS file you wire into your Claude Code MCP config.

## Install

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/jaenster/node-debugger-mcp/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/jaenster/node-debugger-mcp/main/install.ps1 | iex
```

Either bootstraps a checkout into a stable location (`~/.local/share/node-debugger-mcp` / `%LOCALAPPDATA%\node-debugger-mcp`), builds the bundle, and registers with `claude mcp add` at user scope. Re-run any time to update.

After install: in an open Claude Code session, type `/mcp` to reconnect; otherwise the tools appear on next session start. Verify with `claude mcp list`.

### Or from npm

```bash
npm install -g @jaenster/node-debugger-mcp
claude mcp add -s user node-debugger node-debugger-mcp
```

### Flags

- `--allow-raw` — exposes the gated `debug_cdp_raw` escape hatch (`MCP_DEBUGGER_ALLOW_RAW=1`)
- `--scope=user|local|project` — `claude mcp add` scope, defaults to `user`

```bash
curl -fsSL https://raw.githubusercontent.com/jaenster/node-debugger-mcp/main/install.sh | bash -s -- --allow-raw
```

## What you get

Once installed, Claude has these tools available (prefix `debug_`):

**Session lifecycle**
- `debug_launch` — spawn a `.js` script *or* an arbitrary command (`npm run start`, `tsx watch`, `jest`, ...). With `followChildren: "noBreak"` (default), every Node descendant in the process tree is auto-attached as its own session, and worker threads are auto-attached via a runtime shim.
- `debug_attach` — attach by `url`, `host:port`, or `pid` (POSIX, sends SIGUSR1)
- `debug_disconnect` (cascade), `debug_list_sessions`, `debug_status`

**Breakpoints — everything an IDE has**
- `debug_set_breakpoint` — file+line or urlRegex, optional `condition`, `hitCount`, `temporary`
- `debug_set_logpoint` — print an expression on hit without pausing (with optional `captureStack`)
- `debug_set_function_breakpoint` — break when a specific function is invoked from anywhere
- `debug_set_exception_breakpoint` — `none | caught | uncaught | all`, with optional `filter: ["TypeError",...]` for class-name filtering
- `debug_break_on_load` — pause when a script matching a URL pattern is first parsed
- `debug_toggle_breakpoint`, `debug_remove_breakpoint`, `debug_clear_breakpoints`, `debug_list_breakpoints`
- `debug_save_breakpoints` — persist the active BP set to `.node-debugger-mcp.json` (portable across machines, opt-in `autoLoad`)

**Execution control**
- `debug_continue`, `debug_step_over/_into/_out`, `debug_pause`, `debug_run_to_line`, `debug_restart_frame` (top-frame only), `debug_wait_for_pause`

**Inspection**
- `debug_eval` — runs in the current frame's scope when paused, global Runtime otherwise
- `debug_get_stack`, `debug_get_scope`, `debug_get_properties` (drill via stable `obj#N` IDs)
- `debug_get_source`, `debug_list_scripts`
- `debug_get_async_context` — finds every live `AsyncLocalStorage` instance and returns its current `.getStore()` value, drillable. Useful for request-scoped context (trace IDs, tenant info) in real apps.

**Watches + output**
- `debug_add_watch` / `debug_remove_watch` / `debug_list_watches` — auto-re-evaluated on every pause, results included in PauseSnapshot
- `debug_get_output` — stdout / stderr / `Runtime.consoleAPICalled` events (including logpoint output) with cursor-based incremental reads

**Escape hatch (gated)**
- `debug_cdp_raw` — arbitrary `Debugger.*` / `Runtime.*` / `Profiler.*` CDP call. Hidden by default; opt in with `MCP_DEBUGGER_ALLOW_RAW=1` so Claude doesn't default to raw CDP when a higher-level wrapper has a bug.

## Things to know

**TypeScript sources work directly.** Set a breakpoint on `foo.ts:42` and the MCP forward-maps to the compiled JS via the source map. Pause snapshots carry **both** the compiled and original positions, with the snippet drawn from the embedded TS source when available. Tested against `tsc`-built projects; bundler-emitted maps (esbuild, swc, Vite, webpack) work to varying degrees of column accuracy.

**Output is TOON-encoded by default.** [TOON](https://github.com/toon-format/toon) (Token-Oriented Object Notation) is a compact, lossless JSON alternative — ~40% fewer tokens on mixed structures, 30–60% on uniform arrays (stack frames, scope entries). Set `MCP_DEBUGGER_FORMAT=json` to revert.

**Pause snapshots are trimmed.** node-internal frames (`node:internal/*`) are hidden by default; null/empty fields are omitted; snippets are rendered for the top user frame only; depth is capped at 5 frames. Full stack via `debug_get_stack` when you need it.

**Async stack traces are surfaced.** When V8 has an `asyncStackTrace` (set via `setAsyncCallStackDepth(32)` at session start), the pause snapshot carries an `asyncStack` summary — the chain of `Timeout` / `Promise.then` / `await` boundaries leading to the current pause.

**Hot reload works.** With `tsx watch`, `nodemon`, `node --watch`: parent restarts the child Node, the new child announces its inspector on the shared stderr, and the existing auto-attach machinery picks it up. Because BP records are file-keyed and registered with `setBreakpointByUrl`, V8 rebinds them automatically on script reload.

**Worker threads auto-attach** via a `--require`d bootstrap shim that monkey-patches `worker_threads.Worker` to call `inspector.open(0)` per worker. (CDP's `Target.setAutoAttach` does not work for Node workers — verified.) Covers Jest, Vitest, `node:test --experimental-test-isolation`, `tinypool`, etc.

**Concurrency:** one in-flight resume/step/wait per session at a time — a second one returns a clean error rather than silently cancelling. `debug_pause` and read-only inspection tools are always allowed.

## Build from source

```bash
git clone https://github.com/jaenster/node-debugger-mcp.git
cd node-debugger-mcp
./install.sh
```

Or with the smoke-test harness:

```bash
npm install
npm run build
npm run smoke           # basic flow
node scripts/smoke-sourcemap.mjs    # TS / source-map BPs
node scripts/smoke-worker.mjs       # worker_threads auto-attach
node scripts/smoke-async-context.mjs # AsyncLocalStorage discovery
# etc. — see scripts/ for the full set
```

## Uninstall

```bash
claude mcp remove -s user node-debugger
rm -rf ~/.local/share/node-debugger-mcp        # or %LOCALAPPDATA%\node-debugger-mcp on Windows
```

## Stack

TypeScript (ESM, target ES2022), bundled with [`tsup`](https://tsup.egoist.dev/) to a single ~1.9 MB `dist/server.js` (chrome-remote-interface, @modelcontextprotocol/sdk, zod, @jridgewell/trace-mapping, @toon-format/toon all inlined). Speaks the V8 Inspector Protocol over WebSocket via [`chrome-remote-interface`](https://github.com/cyrus-and/chrome-remote-interface). Source maps via [`@jridgewell/trace-mapping`](https://github.com/jridgewell/trace-mapping). Minimum Node 20 LTS.

## License

MIT
