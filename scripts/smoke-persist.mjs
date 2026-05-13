// Smoke for step 13: persistent breakpoints round-trip.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");
const fixturePath = resolve(here, "..", "fixtures", "multi-bp.js");
const persistPath = join(tmpdir(), `ndb-persist-${process.pid}.json`);

if (existsSync(persistPath)) unlinkSync(persistPath);

async function runRound(label, launchExtra) {
  console.log(`\n=== ROUND: ${label} ===`);
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
  const rpc = (method, params) => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
    });
  };
  const call = (name, args) => rpc("tools/call", { name, arguments: args ?? {} });
  const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r);

  await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-persist", version: "0.0.0" },
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await wait(50);

  const launchArgs = { script: fixturePath, ...launchExtra };
  console.log(text(await call("debug_launch", launchArgs)));

  return { mcp, call, text };
}

async function main() {
  // ROUND 1: set BPs, save, exit
  const r1 = await runRound("seed", {});
  console.log(r1.text(await r1.call("debug_set_breakpoint", { file: fixturePath, line: 4 })));
  console.log(r1.text(await r1.call("debug_set_logpoint", { file: fixturePath, line: 7, expression: '"i="+i' })));
  console.log(r1.text(await r1.call("debug_set_exception_breakpoint", { state: "uncaught" })));
  console.log(r1.text(await r1.call("debug_add_watch", { expression: "globalThis.something" })));

  console.log(`\nseed: debug_save_breakpoints to ${persistPath}`);
  console.log(r1.text(await r1.call("debug_save_breakpoints", { path: persistPath })));

  console.log("\nseed: disconnect");
  console.log(r1.text(await r1.call("debug_disconnect", { kill: true })));
  r1.mcp.kill();
  await wait(200);

  // ROUND 2: re-launch with loadPersistedBreakpoints
  const r2 = await runRound("restore (loadPersistedBreakpoints:true)", {
    loadPersistedBreakpoints: true,
    persistPath,
  });

  console.log("\nrestore: list_breakpoints (expect 2 BPs + exception entry)");
  console.log(r2.text(await r2.call("debug_list_breakpoints", {})));

  console.log("\nrestore: list_watches");
  console.log(r2.text(await r2.call("debug_list_watches", {})));

  console.log("\nrestore: disconnect");
  console.log(r2.text(await r2.call("debug_disconnect", { kill: true })));
  r2.mcp.kill();

  if (existsSync(persistPath)) unlinkSync(persistPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
