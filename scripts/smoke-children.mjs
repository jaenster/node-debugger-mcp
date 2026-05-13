// Smoke for step 10: child-process auto-attach via NODE_OPTIONS injection.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");
const parentPath = resolve(here, "..", "fixtures", "multi-proc", "parent.js");
const childPath = resolve(here, "..", "fixtures", "multi-proc", "child.js");

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
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-children", version: "0.0.0" },
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await wait(50);

  console.log("=== launch parent with stopOnEntry:false, followChildren:'noBreak' ===");
  console.log(text(await call("debug_launch", {
    script: parentPath,
    stopOnEntry: false,
    followChildren: "noBreak",
  })));

  // Wait for the child to spawn and be auto-attached.
  await wait(800);

  console.log("\n=== list sessions (expect parent + auto-attached child) ===");
  console.log(text(await call("debug_list_sessions", {})));

  // Find the auto-attached child session by mode.
  const listRes = await call("debug_list_sessions", {});
  const listText = listRes.result?.content?.[0]?.text ?? "";
  const autoMatch = listText.match(/id:\s*(c\d+)/);
  if (!autoMatch) {
    console.error("no auto-attached child session found — auto-attach may have failed");
    mcp.kill();
    process.exit(1);
  }
  const autoId = autoMatch[1];
  console.log(`\nauto-attached child session id: ${autoId}`);

  console.log(`\n=== set BP in child.js at V8 line 4 (the n++ line), against session ${autoId} ===`);
  console.log(text(await call("debug_set_breakpoint", {
    sessionId: autoId,
    file: childPath,
    line: 4,
  })));

  console.log("\n=== wait_for_pause on auto session (BP should hit within ~200ms) ===");
  console.log(text(await call("debug_wait_for_pause", { sessionId: autoId, timeoutMs: 3000 })));

  console.log("\n=== eval 'n' on the auto session ===");
  console.log(text(await call("debug_eval", { sessionId: autoId, expression: "n" })));

  console.log("\n=== continue auto session ===");
  console.log(text(await call("debug_continue", { sessionId: autoId, waitForPause: false })));

  await wait(1500);

  console.log("\n=== final list sessions ===");
  console.log(text(await call("debug_list_sessions", {})));

  console.log("\n=== disconnect (cascade) ===");
  console.log(text(await call("debug_disconnect", { sessionId: "s1", kill: true, cascade: true })));

  mcp.kill();
}

main().catch((err) => {
  console.error(err);
  mcp.kill();
  process.exit(1);
});
