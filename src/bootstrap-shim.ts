// The runtime shim is shipped as a *source string* inlined into the bundle.
// At launch time, the MCP writes this string to a temp .cjs file and adds
// `--require <that path>` to NODE_OPTIONS, so every Node process in the
// target tree loads it.
//
// The shim has two responsibilities:
//   1. In the MAIN thread: monkeypatch worker_threads.Worker so every worker
//      gets the shim --require'd into its execArgv too.
//   2. In any WORKER thread: open an inspector on a free port. Node prints
//      `Debugger listening on ws://...` to stderr, which propagates through
//      inherited stdio up to the MCP, where the existing stderr parser
//      picks it up and creates an auto-session.
//   3. (Optional, step 12) If MCP_DEBUGGER_PAUSE_ON_UNHANDLED_REJECTION=1,
//      register process.on("unhandledRejection") to fire `debugger;`.
//
// The shim is CommonJS because Node's `--require` only loads CJS.

export const BOOTSTRAP_SHIM_SOURCE = `
"use strict";
require("fs").writeSync(2, "[ndb-shim] first-line, pid=" + process.pid + "\\n");
try {
  var inspector = require("node:inspector");
  var wt = require("node:worker_threads");
  require("fs").writeSync(2, "[ndb-shim] loaded, isMainThread=" + wt.isMainThread + " pid=" + process.pid + "\\n");

  if (wt && wt.isMainThread) {
    // --- Main thread side: patch Worker ---
    var bootstrapPath = __filename;
    var OrigWorker = wt.Worker;
    class PatchedWorker extends OrigWorker {
      constructor(filename, options) {
        options = options || {};
        // IMPORTANT: do NOT inherit process.execArgv — that contains
        // --inspect-brk=... in our case and would make every worker halt at
        // its first line without a debugger to release it. Workers don't need
        // the parent's inspector flags; they open their own inspector via
        // inspector.open() in the worker-side branch of this shim.
        var execArgv = (options.execArgv || []).slice();
        if (execArgv.indexOf(bootstrapPath) === -1) {
          execArgv.push("--require", bootstrapPath);
        }
        super(filename, Object.assign({}, options, { execArgv: execArgv }));
      }
    }
    try {
      // Best-effort; some Node builds make these properties read-only.
      wt.Worker = PatchedWorker;
    } catch (e) { /* ignore */ }
  } else {
    // --- Worker thread side: open inspector and wait briefly for attach ---
    try {
      // wait=true so we can set BPs before user worker code runs. The
      // MCP detects the announce via stderr and calls
      // Runtime.runIfWaitingForDebugger to release.
      inspector.open(0, "127.0.0.1", true);
    } catch (e) { /* ignore */ }
  }

  // --- Optional unhandled-rejection pause (step 12) ---
  if (process.env.MCP_DEBUGGER_PAUSE_ON_UNHANDLED_REJECTION === "1") {
    process.on("unhandledRejection", function () {
      try {
        if (inspector.url()) {
          // eslint-disable-next-line no-debugger
          debugger;
        }
      } catch (e) { /* ignore */ }
    });
  }
} catch (err) {
  // The shim must never crash the target. Log to stderr and continue.
  try { process.stderr.write("[node-debugger-mcp bootstrap shim error] " + (err && err.stack || err) + "\\n"); }
  catch (e) { /* ignore */ }
}
`;
