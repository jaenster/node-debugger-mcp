import { defineConfig } from "tsup";

// Make CommonJS `require()` calls inside bundled deps work from ESM output.
// chrome-remote-interface uses `require('events')` etc. internally; without
// this shim tsup's esbuild emits a `__require` that throws on first use.
const cjsShim = [
  "#!/usr/bin/env node",
  "import { createRequire as __cr } from 'node:module';",
  "import { fileURLToPath as __fp } from 'node:url';",
  "import { dirname as __dn } from 'node:path';",
  "const require = __cr(import.meta.url);",
  "const __filename = __fp(import.meta.url);",
  "const __dirname = __dn(__filename);",
].join("\n");

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  shims: false,
  banner: { js: cjsShim },
  noExternal: [
    "@modelcontextprotocol/sdk",
    "@toon-format/toon",
    "@jridgewell/trace-mapping",
    "chrome-remote-interface",
    "zod",
  ],
});
