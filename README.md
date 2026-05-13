# node-debugger-mcp

[![npm](https://img.shields.io/npm/v/@jaenster/node-debugger-mcp.svg?label=npm)](https://www.npmjs.com/package/@jaenster/node-debugger-mcp)
[![license](https://img.shields.io/npm/l/@jaenster/node-debugger-mcp.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@jaenster/node-debugger-mcp.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-blue)](https://modelcontextprotocol.io)

An MCP server that gives Claude a real Node.js debugger — breakpoints, stepping, scope inspection, eval, watches, source-map-aware BPs, child-process and worker-thread auto-attach, and a few things even IDEs don't usually expose like discovering every live `AsyncLocalStorage` instance.

Built because Claude couldn't do any of that. Speaks the V8 Inspector Protocol (the same one Chrome DevTools and JetBrains use), shipped as a single bundled JS file you wire into your Claude Code MCP config.

## Install

One command, same on every platform — works on macOS, Linux and Windows:

```bash
npx -y @jaenster/node-debugger-mcp install
```

That registers the MCP at `user` scope (available in every Claude Code session) with the command set to `npx -y @jaenster/node-debugger-mcp` — so future sessions resolve and run the latest version automatically. Nothing is installed globally; npx caches it under your usual npm cache.

After install: in an open Claude Code session, type `/mcp` to reconnect; otherwise the tools appear on next session start. Verify with `claude mcp list`.

### Flags

```bash
# Expose the gated debug_cdp_raw escape hatch:
npx -y @jaenster/node-debugger-mcp install --allow-raw

# Pin to a specific version instead of latest:
npx -y @jaenster/node-debugger-mcp install --pin=0.1.0

# Project scope (.mcp.json in cwd) or local scope:
npx -y @jaenster/node-debugger-mcp install --scope=project
```

### Status / uninstall

```bash
npx -y @jaenster/node-debugger-mcp doctor       # node version, claude CLI, registration
npx -y @jaenster/node-debugger-mcp uninstall    # removes the registration
```

### Manual registration

If you don't want to run the install subcommand, the equivalent one-liner is:

```bash
claude mcp add -s user node-debugger -- npx -y @jaenster/node-debugger-mcp
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

## What it looks like in practice

The tool list is long but the recurring patterns are short. Four real workflows:

### Debug a failing test

```text
debug_run_tests({ pattern: ["tests/**/*.test.js"] })
  → pre-installs an AssertionError exception BP at launch time, so any
    assertion failure pauses *at the throw site* in the subprocess that's
    running the test.

debug_wait_for_any_pause({ timeoutMs: 30000 })
  → returns { sessionId: "c2", pause: { reason: "exception",
                                        exception: { className, description, ... },
                                        frames: [{ url, line, snippet, ... }] } }
  → the description includes the full Error.toString() with stack.

debug_get_scope({ sessionId: "c2", frameOrdinal: 0 })  // user-frame default
  → see exactly which local variables had which values at the throw.

debug_continue({ sessionId: "c2", waitForPause: false })
  → let the runner report the test as failed and continue.
```

No re-running with extra `console.log` to find the bad value — it's right there at the pause.

### Find a memory leak

```text
debug_launch({ script: "src/server.js", stopOnEntry: false })
debug_heap_snapshot({})        // baseline
  → { path, sizeBytes, nodeCount, topByCount: [...] }

// ... trigger the suspected leak (hit endpoint N times, run import job, ...)

debug_heap_snapshot({})        // after
  → compare topByCount: any class whose count grew unexpectedly is suspect.
```

The two `.heapsnapshot` files load in Chrome DevTools → Memory → Compare for full retainer-path analysis when the class summary isn't enough.

### Find a slow function

```text
debug_launch({ script: "src/build.js", stopOnEntry: false })

debug_cpu_profile({ durationMs: 3000 })
  → topByTotal: [
      { functionName: "tokenize", url, line, samples: 2104 },
      { functionName: "lookup",   url, line, samples:  812 },
      ...
    ]
```

Don't optimise by guessing — optimise whatever's actually on top.

### Inspect request-scoped context

A common pattern in real servers: `AsyncLocalStorage` holds the current request's trace ID, user, tenant. Hit any breakpoint, then:

```text
debug_get_async_context({})
  → instances: [
      { index: 0, store: { preview: "{ requestId: 'r-abc', userId: 42 }", localObjectId: "obj#7" } },
      { index: 1, store: { preview: "{ traceId: 't-xyz', spanId: 's-123' }",  localObjectId: "obj#8" } }
    ]
```

The same pause's `asyncStack` field shows the await/setTimeout/Promise chain that led there — implicit distributed tracing without instrumenting any code.

### Patch a bug live (without restarting)

```text
// You're paused at the bug. You see the wrong expression. Don't want to
// kill the process and rebuild — the state took 20 minutes to reproduce.

debug_get_source({ file: "src/billing.js" })   // grab current source
// ... make your edit in your head ...

debug_patch_source({
  file: "src/billing.js",
  newSource: "<full file with the fix>",
  allowTopFrameEditing: true    // if the buggy function is on the stack
})
  → status: "Ok"        // V8 accepted the patch

debug_continue({})  // resume with the fix applied; state preserved
```

V8 rejects edits that change function arity, scope structure, or top-level ES module imports — the tool returns a status string + a `hint` field explaining what to do.

## Build from source

```bash
git clone https://github.com/jaenster/node-debugger-mcp.git
cd node-debugger-mcp
npm install
npm run build           # produces dist/server.js
npm run smoke           # basic flow against fixtures/hello.js

# Other smoke harnesses for specific features:
node scripts/smoke-sourcemap.mjs        # TS / source-map BPs
node scripts/smoke-worker.mjs           # worker_threads auto-attach
node scripts/smoke-async-context.mjs    # AsyncLocalStorage discovery
node scripts/smoke-children.mjs         # child-process auto-attach
node scripts/smoke-persist.mjs          # persistent breakpoint round-trip
# … see scripts/ for the full set
```

To register a development checkout with Claude Code without going through npm:

```bash
claude mcp add -s user node-debugger node /absolute/path/to/dist/server.js
```

## Stack

TypeScript (ESM, target ES2022), bundled with [`tsup`](https://tsup.egoist.dev/) to a single ~1.9 MB `dist/server.js` (chrome-remote-interface, @modelcontextprotocol/sdk, zod, @jridgewell/trace-mapping, @toon-format/toon all inlined). Speaks the V8 Inspector Protocol over WebSocket via [`chrome-remote-interface`](https://github.com/cyrus-and/chrome-remote-interface). Source maps via [`@jridgewell/trace-mapping`](https://github.com/jridgewell/trace-mapping). Minimum Node 20 LTS.

## Related

Other MCP servers by the same author:

- [**remote-shell-mcp**](https://github.com/jaenster/remote-shell-mcp) — persistent SSH, SFTP, port forwarding, and Docker over MCP. A long-running daemon so sessions, tunnels, and PTY shells survive across Claude Code / Claude Desktop / Cursor / Codex CLI restarts.

## Links

- [npm: @jaenster/node-debugger-mcp](https://www.npmjs.com/package/@jaenster/node-debugger-mcp)
- [GitHub releases](https://github.com/jaenster/node-debugger-mcp/releases)
- [Issues / bug reports](https://github.com/jaenster/node-debugger-mcp/issues)
- [Model Context Protocol spec](https://modelcontextprotocol.io)

## License

[MIT](LICENSE) © jaenster
