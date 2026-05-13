// Day-1 spike: does Target.setAutoAttach + Target.attachedToTarget fire for
// node:worker_threads in modern Node? The plan flagged this as the largest
// unverified assumption for step 11.
//
// Procedure:
//   1. spawn `node --inspect-brk=127.0.0.1:0 fixtures/worker-app/parent.js`
//   2. wait for the inspector announce
//   3. attach CDP, enable Debugger + Runtime
//   4. send Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:false, flatten:true})
//   5. send Runtime.runIfWaitingForDebugger
//   6. log every CDP event for ~3 seconds
//   7. report whether we saw Target.attachedToTarget for the worker

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import CDP from "chrome-remote-interface";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "..", "fixtures", "worker-app", "parent.js");

const target = spawn(process.execPath, ["--inspect-brk=127.0.0.1:0", fixture], {
  stdio: ["ignore", "inherit", "pipe"],
});

const wsUrl = await new Promise((resolveWs, rejectWs) => {
  let buf = "";
  target.stderr.on("data", (b) => {
    process.stderr.write(b);
    buf += b.toString("utf8");
    const m = buf.match(/Debugger listening on (ws:\/\/\S+)/);
    if (m) resolveWs(m[1]);
  });
  setTimeout(() => rejectWs(new Error("timeout")), 5000);
});

console.log(`\n[spike] connecting CDP to ${wsUrl}`);
const client = await CDP({ target: wsUrl });

const seenEvents = new Set();
const sawAttachedToTarget = [];
client.on("event", (msg) => {
  seenEvents.add(msg.method);
  if (msg.method === "Target.attachedToTarget") {
    sawAttachedToTarget.push(msg.params);
    console.log(`[spike] >>> Target.attachedToTarget fired:`, JSON.stringify(msg.params.targetInfo));
  }
  if (msg.method === "Target.targetCreated") {
    console.log(`[spike] Target.targetCreated:`, JSON.stringify(msg.params.targetInfo));
  }
});

await client.Debugger.enable({});
await client.Runtime.enable();
console.log("[spike] enabling Target.setAutoAttach...");
try {
  await client.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  console.log("[spike] Target.setAutoAttach OK");
} catch (e) {
  console.log("[spike] Target.setAutoAttach REJECTED:", String(e));
}

await client.Runtime.runIfWaitingForDebugger();

await wait(3000);

console.log("\n[spike] === RESULTS ===");
console.log("[spike] events observed:", Array.from(seenEvents).sort().join(", "));
console.log("[spike] Target.attachedToTarget fired", sawAttachedToTarget.length, "times");
if (sawAttachedToTarget.length === 0) {
  console.log("[spike] CONCLUSION: Node's worker_threads does NOT integrate with Target.setAutoAttach");
  console.log("[spike] FALLBACK NEEDED: monkeypatch Worker in bootstrap shim or use a different mechanism");
} else {
  console.log("[spike] CONCLUSION: Target.setAutoAttach WORKS for worker_threads");
}

await client.close();
target.kill("SIGTERM");
