// Build a hand-crafted webpack-style sourcemap fixture in a temp directory.
//
// Strategy: compile a TS file with tsc to get a real (valid VLQ) sourcemap,
// then mutate the `sources` field from the tsc form (`../foo.ts`) to a
// webpack form (`webpack:///./src/foo.ts`). The mappings are preserved so
// position lookups still work; only the source URL conventions differ —
// exactly what we want to test our normalizeSource against.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const outDir = process.argv[2] ?? resolve(tmpdir(), `ndb-webpack-${process.pid}`);
if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(resolve(outDir, "src"), { recursive: true });
mkdirSync(resolve(outDir, "dist"), { recursive: true });

// 1. A real TS source we'll pretend was webpack-bundled.
const tsSource = `// Webpack-style source-map fixture.
function compute(x: number, y: number): number {
  const sum = x + y; // BP MARKER — V8 line 2 (0-indexed) in compiled JS
  return sum;
}

const result = compute(2, 3);
console.log("result:", result);
`;
writeFileSync(resolve(outDir, "src", "compute.ts"), tsSource);

// 2. Compile with tsc to get a valid sourcemap.
const tsc = resolve(repoRoot, "node_modules", ".bin", "tsc");
const tscRes = spawnSync(tsc, [
  resolve(outDir, "src", "compute.ts"),
  "--target", "ES2022",
  "--module", "ESNext",
  "--moduleResolution", "Bundler",
  "--outDir", resolve(outDir, "dist"),
  "--sourceMap",
  "--rootDir", resolve(outDir, "src"),
  "--skipLibCheck",
], { encoding: "utf8" });
if (tscRes.status !== 0) {
  console.error("tsc failed:", tscRes.stderr || tscRes.stdout);
  process.exit(1);
}

// 3. Mutate the map: replace `sources` with webpack-style URLs.
const mapPath = resolve(outDir, "dist", "compute.js.map");
const map = JSON.parse(readFileSync(mapPath, "utf8"));
map.sources = ["webpack:///./src/compute.ts"];
// Drop sourcesContent to test the disk-fallback path simultaneously.
delete map.sourcesContent;
delete map.sourceRoot;
writeFileSync(mapPath, JSON.stringify(map));

console.log(JSON.stringify({
  outDir,
  bundle: resolve(outDir, "dist", "compute.js"),
  source: resolve(outDir, "src", "compute.ts"),
  mapPath,
}));
