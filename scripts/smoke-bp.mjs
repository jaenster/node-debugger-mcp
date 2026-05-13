// Smoke harness for the extended breakpoint kinds (step 6):
// hit-count, temporary, exception, function-call.

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
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg);
    pending.delete(msg.id);
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n",
    );
  });
}
const call = (name, args) => rpc("tools/call", { name, arguments: args ?? {} });
const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r);

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-bp", version: "0.0.0" },
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
  await wait(50);

  console.log("=== launch fixture (stopOnEntry, default) ===");
  console.log(text(await call("debug_launch", { script: fixturePath })));

  console.log("\n=== set hit-count BP at multiply (V8 line 4) hitCount:3 ===");
  console.log(
    text(
      await call("debug_set_breakpoint", {
        file: fixturePath,
        line: 4,
        hitCount: 3,
      }),
    ),
  );

  console.log("\n=== continue: should pause on 3rd iteration of multiply ===");
  const cont1 = await call("debug_continue", { waitForPause: true, timeoutMs: 5000 });
  console.log(text(cont1));

  console.log("\n=== eval 'a, b' on top frame (i=2 → items[2]=3 → a=3, b=2) ===");
  console.log(text(await call("debug_eval", { expression: "({a,b})" })));

  console.log("\n=== clear all breakpoints ===");
  console.log(text(await call("debug_clear_breakpoints", {})));

  console.log("\n=== set exception breakpoint state:'all' ===");
  console.log(text(await call("debug_set_exception_breakpoint", { state: "all" })));

  console.log("\n=== continue: should pause inside maybeThrows on the throw ===");
  const cont2 = await call("debug_continue", { waitForPause: true, timeoutMs: 5000 });
  console.log(text(cont2));

  console.log("\n=== eval the thrown value (top frame; 'e' is not yet bound, look at the throw expression) ===");
  console.log(text(await call("debug_eval", { expression: "x" })));

  console.log("\n=== set exception 'none' (disable), continue to finish ===");
  console.log(text(await call("debug_set_exception_breakpoint", { state: "none" })));
  console.log(text(await call("debug_continue", { waitForPause: false })));

  await wait(300);

  console.log("\n=== disconnect ===");
  console.log(text(await call("debug_disconnect", { kill: true })));

  child.kill();
}

main().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
