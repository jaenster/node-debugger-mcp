// Smoke for debug_cpu_profile and debug_heap_snapshot.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");
const fixturePath = resolve(here, "..", "fixtures", "perf", "busy.cjs");

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

  console.log("=== launch busy.cjs (stopOnEntry:false) ===");
  console.log(text(await call("debug_launch", { script: fixturePath, stopOnEntry: false, followChildren: "off" })));

  await wait(300); // let it ramp up

  console.log("\n=== debug_cpu_profile durationMs:1500 topN:10 ===");
  console.log(text(await call("debug_cpu_profile", { durationMs: 1500, topN: 10 })));

  console.log("\n=== debug_heap_snapshot ===");
  console.log(text(await call("debug_heap_snapshot", {})));

  console.log("\n=== disconnect ===");
  console.log(text(await call("debug_disconnect", { kill: true })));
  mcp.kill();
}

main().catch((err) => { console.error(err); mcp.kill(); process.exit(1); });
