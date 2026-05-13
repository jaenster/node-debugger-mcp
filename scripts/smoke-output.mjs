// Smoke for steps 7 + 8: watches + output capture + logpoint (which depends on output).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");
const fixturePath = resolve(here, "..", "fixtures", "multi-bp.js");

let nextId = 1;
const pending = new Map();

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env },
});

const out = createInterface({ input: child.stdout });
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
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
  });
}
const call = (name, args) => rpc("tools/call", { name, arguments: args ?? {} });
const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r);

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-out", version: "0.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await wait(50);

  console.log("=== launch fixture ===");
  console.log(text(await call("debug_launch", { script: fixturePath })));

  console.log("\n=== add a watch: 'inputs && inputs.length' ===");
  console.log(text(await call("debug_add_watch", { expression: "inputs && inputs.length" })));

  console.log("\n=== add a watch: 'doubled' (not yet defined → error) ===");
  console.log(text(await call("debug_add_watch", { expression: "doubled" })));

  console.log("\n=== set logpoint at multiply (V8 line 4), expression: 'a + \"*\" + b' ===");
  console.log(
    text(
      await call("debug_set_logpoint", {
        file: fixturePath,
        line: 4,
        expression: 'a + "*" + b',
      }),
    ),
  );

  console.log("\n=== set hit-count BP at line 25 (after processItems completes) hitCount:1 ===");
  // Line 25 (0-indexed) is `const doubled = processItems(inputs);` → V8 line 23
  console.log(
    text(
      await call("debug_set_breakpoint", {
        file: fixturePath,
        line: 24, // line after `const doubled = ...`
      }),
    ),
  );

  console.log("\n=== continue: should run logpoint 5x then pause at line 24 ===");
  console.log(text(await call("debug_continue", { waitForPause: true, timeoutMs: 5000 })));

  console.log("\n=== get_output console (logpoint lines should appear here) ===");
  const out1 = await call("debug_get_output", { stream: "console" });
  console.log(text(out1));

  console.log("\n=== get_output stdout (the script's console.log calls) ===");
  console.log(text(await call("debug_get_output", { stream: "stdout" })));

  console.log("\n=== continue to finish ===");
  console.log(text(await call("debug_continue", { waitForPause: false })));

  await wait(400);

  console.log("\n=== get_output all (final state) ===");
  console.log(text(await call("debug_get_output", { stream: "all" })));

  console.log("\n=== disconnect ===");
  console.log(text(await call("debug_disconnect", { kill: true })));

  child.kill();
}

main().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
