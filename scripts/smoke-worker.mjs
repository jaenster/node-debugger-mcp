// Smoke for step 11: worker-thread auto-attach via bootstrap shim.
// Spawns fixtures/worker-app/parent.js with followChildren:"noBreak" — the shim
// monkeypatches worker_threads.Worker so the worker opens its own inspector,
// announces on stderr, and our auto-attach machinery creates a session.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");
const parentPath = resolve(here, "..", "fixtures", "worker-app", "parent.js");
const workerPath = resolve(here, "..", "fixtures", "worker-app", "worker.js");

let nextId = 1;
const pending = new Map();

const mcp = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
});
const out = createInterface({ input: mcp.stdout });
out.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg);
    pending.delete(msg.id);
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
  });
}
const call = (name, args) => rpc("tools/call", { name, arguments: args ?? {} });
const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r);

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-worker", version: "0.0.0" },
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await wait(50);

  console.log("=== launch parent (followChildren:'noBreak'; worker shim should also kick in) ===");
  console.log(text(await call("debug_launch", {
    script: parentPath,
    stopOnEntry: false,
    followChildren: "noBreak",
  })));

  await wait(600);

  console.log("\n=== parent stderr (expect shim diagnostic + worker Debugger-listening) ===");
  console.log(text(await call("debug_get_output", { sessionId: "s1", stream: "stderr", tail: 50 })));

  console.log("\n=== parent stdout (expect 'parent starting, pid:' line) ===");
  console.log(text(await call("debug_get_output", { sessionId: "s1", stream: "stdout", tail: 50 })));

  await wait(1000);
  console.log("\n=== parent stderr after 1s more ===");
  console.log(text(await call("debug_get_output", { sessionId: "s1", stream: "stderr", tail: 50 })));

  console.log("\n=== list_sessions (expect parent + worker auto-session) ===");
  console.log(text(await call("debug_list_sessions", {})));

  // The worker session id starts with "c" (children minted via mintId("c")).
  const listText = (await call("debug_list_sessions", {})).result?.content?.[0]?.text ?? "";
  const autoMatch = listText.match(/id:\s*(c\d+)/);
  if (!autoMatch) {
    console.error("\nFAIL: no auto-attached worker session discovered");
    mcp.kill();
    process.exit(1);
  }
  const autoId = autoMatch[1];
  console.log(`\n>>> worker auto-session id: ${autoId}`);

  console.log(`\n=== list_scripts on worker (should include worker.js) ===`);
  console.log(text(await call("debug_list_scripts", { sessionId: autoId })));

  console.log(`\n=== set BP in worker.js V8 line 8 (the n++ statement) on ${autoId} ===`);
  console.log(text(await call("debug_set_breakpoint", {
    sessionId: autoId,
    file: workerPath,
    line: 8,
  })));

  console.log("\n=== wait_for_pause on worker (BP should hit on first iteration) ===");
  console.log(text(await call("debug_wait_for_pause", { sessionId: autoId, timeoutMs: 3000 })));

  console.log("\n=== eval 'n' in worker frame ===");
  console.log(text(await call("debug_eval", { sessionId: autoId, expression: "n" })));

  console.log("\n=== continue worker ===");
  console.log(text(await call("debug_continue", { sessionId: autoId, waitForPause: false })));

  await wait(800);

  console.log("\n=== disconnect (cascade) ===");
  console.log(text(await call("debug_disconnect", { sessionId: "s1", kill: true, cascade: true })));

  mcp.kill();
}

main().catch((err) => {
  console.error(err);
  mcp.kill();
  process.exit(1);
});
