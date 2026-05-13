// Manual end-to-end smoke harness for the MCP server.
// Spawns node dist/server.js, exchanges JSON-RPC frames over stdio,
// and prints whatever it gets back.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");

let nextId = 1;
const pending = new Map();

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env },
});

const out = createInterface({ input: child.stdout });
out.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    console.error("non-JSON stdout from server:", trimmed.slice(0, 200));
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

function rpc(method, params) {
  const id = nextId++;
  const frame = { jsonrpc: "2.0", id, method, params: params ?? {} };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(frame) + "\n");
  });
}

async function main() {
  // MCP requires an `initialize` before anything else.
  const initRes = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  console.log("=== initialize ===");
  console.log(JSON.stringify(initRes.result, null, 2));

  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );

  await wait(50);

  const listRes = await rpc("tools/list");
  console.log("\n=== tools/list ===");
  console.log(JSON.stringify(listRes.result, null, 2));

  const pingRes = await rpc("tools/call", {
    name: "debug_ping",
    arguments: { message: "hello from smoke" },
  });
  console.log("\n=== tools/call debug_ping ===");
  console.log(pingRes.result.content[0].text);

  const fixturePath = resolve(here, "..", "fixtures", "hello.js");

  console.log("\n=== tools/call debug_launch (fixture, stopOnEntry default) ===");
  const launchRes = await rpc("tools/call", {
    name: "debug_launch",
    arguments: { script: fixturePath },
  });
  console.log(launchRes.result.content?.[0]?.text ?? JSON.stringify(launchRes));

  console.log("\n=== tools/call debug_status ===");
  const statusRes = await rpc("tools/call", {
    name: "debug_status",
    arguments: {},
  });
  console.log(statusRes.result.content?.[0]?.text ?? JSON.stringify(statusRes));

  console.log("\n=== tools/call debug_set_breakpoint (hello.js:4, the marker line — V8 0-indexed) ===");
  // The marker in fixtures/hello.js is line 5 in 1-indexed terms (the `const greeting = ...`).
  // V8 lineNumber is 0-indexed → line 4.
  const setBpRes = await rpc("tools/call", {
    name: "debug_set_breakpoint",
    arguments: { file: fixturePath, line: 4 },
  });
  console.log(setBpRes.result.content?.[0]?.text ?? JSON.stringify(setBpRes));

  console.log("\n=== tools/call debug_continue waitForPause:true ===");
  const contRes = await rpc("tools/call", {
    name: "debug_continue",
    arguments: { waitForPause: true, timeoutMs: 5000 },
  });
  console.log(contRes.result.content?.[0]?.text ?? JSON.stringify(contRes));

  console.log("\n=== tools/call debug_eval 'name' (in greet's frame) ===");
  const evalNameRes = await rpc("tools/call", {
    name: "debug_eval",
    arguments: { expression: "name" },
  });
  console.log(evalNameRes.result.content?.[0]?.text ?? JSON.stringify(evalNameRes));

  console.log("\n=== tools/call debug_eval 'name.length + 1' ===");
  const evalLenRes = await rpc("tools/call", {
    name: "debug_eval",
    arguments: { expression: "name.length + 1" },
  });
  console.log(evalLenRes.result.content?.[0]?.text ?? JSON.stringify(evalLenRes));

  console.log("\n=== tools/call debug_get_scope frameOrdinal:0 scopeType:'local' ===");
  const scopeRes = await rpc("tools/call", {
    name: "debug_get_scope",
    arguments: { frameOrdinal: 0, scopeType: "local" },
  });
  console.log(scopeRes.result.content?.[0]?.text ?? JSON.stringify(scopeRes));

  console.log("\n=== tools/call debug_eval '({a:1,b:[10,20],c:{deep:true}})' (returns object) ===");
  const evalObjRes = await rpc("tools/call", {
    name: "debug_eval",
    arguments: { expression: "({a:1,b:[10,20],c:{deep:true}})" },
  });
  console.log(evalObjRes.result.content?.[0]?.text ?? JSON.stringify(evalObjRes));

  // Parse the localObjectId out of the response text — sloppy but smoke-only.
  const evalObjText = evalObjRes.result.content?.[0]?.text ?? "";
  const objIdMatch = evalObjText.match(/localObjectId:\s*"?([^\s"]+)"?/);
  if (objIdMatch) {
    console.log(`\n=== tools/call debug_get_properties ${objIdMatch[1]} ===`);
    const propsRes = await rpc("tools/call", {
      name: "debug_get_properties",
      arguments: { localObjectId: objIdMatch[1] },
    });
    console.log(propsRes.result.content?.[0]?.text ?? JSON.stringify(propsRes));
  }

  console.log("\n=== tools/call debug_list_scripts urlFilter:'fixtures/hello.js' ===");
  const listScrRes = await rpc("tools/call", {
    name: "debug_list_scripts",
    arguments: { urlFilter: "fixtures/hello.js" },
  });
  console.log(listScrRes.result.content?.[0]?.text ?? JSON.stringify(listScrRes));

  console.log("\n=== tools/call debug_step_over ===");
  const stepRes = await rpc("tools/call", {
    name: "debug_step_over",
    arguments: { waitForPause: true, timeoutMs: 5000 },
  });
  console.log(stepRes.result.content?.[0]?.text ?? JSON.stringify(stepRes));

  console.log("\n=== tools/call debug_list_breakpoints (hit count should be 1) ===");
  const listBpRes = await rpc("tools/call", {
    name: "debug_list_breakpoints",
    arguments: {},
  });
  console.log(listBpRes.result.content?.[0]?.text ?? JSON.stringify(listBpRes));

  console.log("\n=== tools/call debug_continue waitForPause:false (let it finish) ===");
  const cont2Res = await rpc("tools/call", {
    name: "debug_continue",
    arguments: { waitForPause: false },
  });
  console.log(cont2Res.result.content?.[0]?.text ?? JSON.stringify(cont2Res));

  await wait(300);

  console.log("\n=== tools/call debug_list_sessions ===");
  const listSessionsRes = await rpc("tools/call", {
    name: "debug_list_sessions",
    arguments: {},
  });
  console.log(
    listSessionsRes.result.content?.[0]?.text ?? JSON.stringify(listSessionsRes),
  );

  console.log("\n=== tools/call debug_disconnect (kill) ===");
  const discRes = await rpc("tools/call", {
    name: "debug_disconnect",
    arguments: { kill: true },
  });
  console.log(discRes.result.content?.[0]?.text ?? JSON.stringify(discRes));

  child.kill();
}

main().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
