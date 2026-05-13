// Resolve and (lazily) materialise the bootstrap shim as a temp file
// on first use, so we can pass `--require <that path>` to Node.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOTSTRAP_SHIM_SOURCE } from "../bootstrap-shim.js";

let cachedPath: string | undefined;

export function bootstrapShimPath(): string {
  if (cachedPath) return cachedPath;
  const dir = join(tmpdir(), "node-debugger-mcp");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  // Suffix with pid so concurrent MCP servers don't fight over the file.
  const path = join(dir, `bootstrap-${process.pid}.cjs`);
  if (!existsSync(path)) {
    writeFileSync(path, BOOTSTRAP_SHIM_SOURCE, "utf8");
  }
  cachedPath = path;
  return path;
}
