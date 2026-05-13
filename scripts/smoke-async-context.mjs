// Smoke for debug_get_async_context.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");
const fixturePath = resolve(here, "..", "fixtures", "async-context", "server.cjs");

let nextId = 1;
const pending = new Map();
const mcp = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
const out = createInterface({ input: mcp.stdout });
out.on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg); pending.delete(msg.id);
  }
});
const rpc = (method, params) => {
  const id = nextId++;
  return new Promise((r) => {
    pending.set(id, { resolve: r });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
  });
};
const call = (name, args) => rpc("tools/call", { name, arguments: args ?? {} });
const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r);

async function main() {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "s", version: "0" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await wait(50);

  console.log("=== launch fixture (stopOnEntry:false) ===");
  console.log(text(await call("debug_launch", { script: fixturePath, stopOnEntry: false, followChildren: "off" })));

  console.log("\n=== set BP at server.cjs V8 line 10 (the console.log in tick) ===");
  console.log(text(await call("debug_set_breakpoint", { file: fixturePath, line: 10 })));

  console.log("\n=== wait_for_pause ===");
  console.log(text(await call("debug_wait_for_pause", { timeoutMs: 3000 })));

  console.log("\n=== debug_get_async_context (expect 2 instances with stores) ===");
  console.log(text(await call("debug_get_async_context", {})));

  console.log("\n=== continue + disconnect ===");
  console.log(text(await call("debug_continue", { waitForPause: false })));
  console.log(text(await call("debug_disconnect", { kill: true })));
  mcp.kill();
}

main().catch((err) => { console.error(err); mcp.kill(); process.exit(1); });
