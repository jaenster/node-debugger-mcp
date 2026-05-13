// Source-map indexing for source-aware breakpoints + reverse-mapped frames.
//
// Note on coordinate systems:
//   - V8 / CDP / our internal types: line is 0-indexed, column is 0-indexed.
//   - @jridgewell/trace-mapping: line is 1-indexed, column is 0-indexed.
//
// Every conversion across the boundary is annotated.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  resolve as pathResolve,
  dirname as pathDirname,
  isAbsolute,
  sep as pathSep,
} from "node:path";
import {
  TraceMap,
  originalPositionFor,
  generatedPositionFor,
  sourceContentFor,
  LEAST_UPPER_BOUND,
} from "@jridgewell/trace-mapping";
import { log } from "../util/log.js";

export interface CompiledPosition {
  scriptId: string;
  scriptUrl: string;
  line0: number;
  column0: number;
}

export interface OriginalPosition {
  url: string;
  line0: number;
  column0: number;
}

interface IndexedMap {
  scriptId: string;
  scriptUrl: string;
  sourceMapURL: string;
  traceMap: TraceMap;
  /** Resolved absolute sources (best-effort). Maps `sources[i]` → absolute path or original entry. */
  normalizedSources: string[];
  /** Original `sources[i]` array as stored in the map (used for trace-mapping queries). */
  rawSources: string[];
}

export class SourceMapIndex {
  private byScriptId = new Map<string, IndexedMap>();

  async ingest(opts: {
    scriptId: string;
    scriptUrl: string;
    sourceMapURL: string;
  }): Promise<void> {
    if (!opts.sourceMapURL) return;
    try {
      const raw = await fetchSourceMap(opts.sourceMapURL, opts.scriptUrl);
      const tm = new TraceMap(raw as never);
      const rawSources: string[] = (tm as unknown as { sources: (string | null)[] }).sources.map(
        (s) => s ?? "",
      );
      const normalizedSources = rawSources.map((s) => normalizeSource(s, opts.scriptUrl, raw.sourceRoot));
      this.byScriptId.set(opts.scriptId, {
        scriptId: opts.scriptId,
        scriptUrl: opts.scriptUrl,
        sourceMapURL: opts.sourceMapURL,
        traceMap: tm,
        rawSources,
        normalizedSources,
      });
      log.debug(
        `sourcemap indexed for ${opts.scriptUrl} → ${normalizedSources.length} source(s)`,
      );
    } catch (e) {
      log.debug(`sourcemap ingest failed for ${opts.scriptUrl}: ${String(e)}`);
    }
  }

  forget(scriptId: string): void {
    this.byScriptId.delete(scriptId);
  }

  /**
   * Find compiled positions for a source file:line. May return multiple if
   * several scripts include this source.
   */
  forwardMap(opts: {
    sourcePath: string;
    line0: number;
    column0?: number;
  }): CompiledPosition[] {
    const wantAbs = absolutize(opts.sourcePath);
    const out: CompiledPosition[] = [];
    for (const entry of this.byScriptId.values()) {
      // Find a source in this map matching the requested path.
      const idx = matchSourceIndex(entry.normalizedSources, wantAbs, opts.sourcePath);
      if (idx < 0) continue;
      const rawSource = entry.rawSources[idx]!;
      try {
        const gen = generatedPositionFor(entry.traceMap, {
          source: rawSource,
          line: opts.line0 + 1, // → 1-indexed
          column: opts.column0 ?? 0,
          bias: LEAST_UPPER_BOUND,
        });
        if (gen.line === null || gen.column === null) continue;
        out.push({
          scriptId: entry.scriptId,
          scriptUrl: entry.scriptUrl,
          line0: gen.line - 1, // → 0-indexed
          column0: gen.column,
        });
      } catch {
        // ignore — bad map data
      }
    }
    return out;
  }

  reverseMap(opts: {
    scriptId: string;
    line0: number;
    column0: number;
  }): OriginalPosition | null {
    const entry = this.byScriptId.get(opts.scriptId);
    if (!entry) return null;
    try {
      const orig = originalPositionFor(entry.traceMap, {
        line: opts.line0 + 1, // → 1-indexed
        column: opts.column0,
      });
      if (orig.source === null || orig.line === null || orig.column === null) return null;
      // Match via exact then suffix — trace-mapping may return a slightly
      // different form than what we stored in rawSources (e.g. it strips
      // `./` segments, which our raw store didn't). Strip protocol +
      // leading `./` from both sides before comparing.
      const stripForCompare = (s: string) =>
        s.replace(/\\/g, "/").replace(/^[a-z]+:\/+/i, "").replace(/^\.\//, "");
      let normalized: string | undefined;
      const exact = entry.rawSources.indexOf(orig.source);
      if (exact >= 0) {
        normalized = entry.normalizedSources[exact];
      } else {
        const wantStripped = stripForCompare(orig.source);
        for (let i = 0; i < entry.rawSources.length; i++) {
          if (stripForCompare(entry.rawSources[i] ?? "") === wantStripped) {
            normalized = entry.normalizedSources[i];
            break;
          }
        }
      }
      return {
        url: normalized ?? orig.source,
        line0: orig.line - 1, // → 0-indexed
        column0: orig.column,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the source for `sourceUrl` as the runtime sees it via the sourcemap.
   * Tries embedded `sourcesContent` first. Falls back to reading the file
   * from disk when the sourcemap was emitted without inline sources (e.g.
   * esbuild's default). Returns undefined when neither is available —
   * caller should omit the snippet rather than render something misleading.
   */
  sourceContent(scriptId: string, sourceUrl: string): string | undefined {
    const entry = this.byScriptId.get(scriptId);
    if (!entry) return undefined;
    // Find which sources[i] corresponds to the requested URL.
    let idx = -1;
    const wantFwd = sourceUrl.replace(/\\/g, "/");
    for (let i = 0; i < entry.normalizedSources.length; i++) {
      const norm = (entry.normalizedSources[i] ?? "").replace(/\\/g, "/");
      const raw = entry.rawSources[i] ?? "";
      if (
        norm === wantFwd ||
        raw === sourceUrl ||
        absolutize(norm) === absolutize(wantFwd)
      ) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return undefined;
    try {
      const embedded = sourceContentFor(entry.traceMap, entry.rawSources[idx]!);
      if (embedded != null) return embedded;
    } catch {
      // fall through to disk
    }
    // sourcesContent is missing. Try disk — sync read is fine here since
    // snippets are rendered on the pause path which is already chatty.
    const norm = entry.normalizedSources[idx] ?? "";
    if (!norm) return undefined;
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const candidates: string[] = [];
      if (isAbsolute(norm)) {
        candidates.push(norm);
      } else if (entry.scriptUrl.startsWith("file://")) {
        // For project-relative sources (e.g. webpack:///./src/foo.ts which
        // we stored as `src/foo.ts`), try resolving against likely roots:
        // the script's dir, its parent, grandparent. Catches the typical
        // `<root>/dist/bundle.js` + `<root>/src/foo.ts` layout.
        try {
          const scriptPath = fileURLToPath(entry.scriptUrl);
          let dir = pathDirname(scriptPath);
          for (let i = 0; i < 5; i++) {
            candidates.push(pathResolve(dir, norm));
            const parent = pathDirname(dir);
            if (parent === dir) break;
            dir = parent;
          }
        } catch {
          /* ignore */
        }
      }
      for (const c of candidates) {
        try {
          return fs.readFileSync(c, "utf8");
        } catch {
          continue;
        }
      }
    } catch {
      /* not available; caller will omit */
    }
    return undefined;
  }

  has(scriptId: string): boolean {
    return this.byScriptId.has(scriptId);
  }
}

function matchSourceIndex(
  normalized: string[],
  wantAbs: string,
  wantRaw: string,
): number {
  // Normalize all candidates to forward-slash form so Windows backslashes
  // don't break suffix matching when the caller passed POSIX-style paths
  // (or vice versa).
  const wantAbsFwd = wantAbs.replace(/\\/g, "/");
  const wantRawFwd = wantRaw.replace(/\\/g, "/");
  const normFwd = normalized.map((n) => (n ?? "").replace(/\\/g, "/"));

  // 1. Exact match against the normalized absolute paths.
  for (let i = 0; i < normFwd.length; i++) {
    if (normFwd[i] === wantAbsFwd) return i;
  }
  // 2. Suffix match against the raw or normalized — handles bundlers whose
  //    `sources[]` is something like `webpack:///./src/foo.ts` while the
  //    caller passed `src/foo.ts` or `/abs/path/src/foo.ts`.
  for (let i = 0; i < normFwd.length; i++) {
    const norm = normFwd[i] ?? "";
    if (norm.endsWith(wantAbsFwd) || norm.endsWith(wantRawFwd)) return i;
    if (wantAbsFwd.endsWith(norm) || wantRawFwd.endsWith(norm)) return i;
  }
  return -1;
}

function absolutize(p: string): string {
  if (p.startsWith("file://")) {
    try {
      return fileURLToPath(p);
    } catch {
      return p.slice(7);
    }
  }
  return p;
}

function normalizeSource(
  src: string,
  scriptUrl: string,
  sourceRoot?: string,
): string {
  if (!src) return "";
  // Strip query/hash suffixes that some bundlers append (e.g. `foo.ts?v=123`).
  src = src.replace(/[?#].*$/, "");
  // Apply sourceRoot if the source is relative. Some bundlers set sourceRoot
  // to a protocol URL like `webpack:///` which still counts as a "root" to
  // join against.
  if (sourceRoot && !/^([a-z][a-z0-9+.-]*:|\/)/i.test(src)) {
    src = sourceRoot.endsWith("/") ? sourceRoot + src : `${sourceRoot}/${src}`;
  }
  // Detect bundler protocol prefixes BEFORE stripping. Sources behind these
  // protocols are conceptually project-relative (relative to the user's repo
  // root, not the bundle output dir) — resolving them against the script's
  // dist directory produces garbage paths. We strip the protocol and keep
  // the bare-relative form so suffix matching against the user's path works.
  const hadBundlerProtocol =
    /^webpack(?:-internal)?:\/\//.test(src) ||
    /^rollup:\/\/\//.test(src) ||
    /^vite:\/\//.test(src);
  src = src.replace(/^webpack:\/\/\/?(?:\.\/)?/, "");
  src = src.replace(/^webpack-internal:\/\/\//, "");
  src = src.replace(/^webpack:\/\//, "");
  src = src.replace(/^rollup:\/\/\//, "");
  src = src.replace(/^vite:\/\//, "");
  if (src.startsWith("file://")) {
    try {
      return fileURLToPath(src);
    } catch {
      return src.slice(7);
    }
  }
  if (isAbsolute(src)) return src;
  if (hadBundlerProtocol) {
    // Don't resolve against the bundle's dir — keep the project-relative
    // form (e.g. `src/foo.ts`) so suffix-matching against the user's path
    // (`/abs/repo/src/foo.ts`) succeeds.
    return src.replace(/^\.\//, "");
  }
  // Resolve relative to the script URL's directory, collapsing `..` and `.`.
  if (scriptUrl.startsWith("file://")) {
    try {
      const scriptPath = fileURLToPath(scriptUrl);
      const dir = pathDirname(scriptPath);
      return pathResolve(dir, src);
    } catch {
      return src;
    }
  }
  return src;
}

async function fetchSourceMap(
  sourceMapURL: string,
  scriptUrl: string,
): Promise<{ sourceRoot?: string } & Record<string, unknown>> {
  // data: URI variants
  if (sourceMapURL.startsWith("data:")) {
    const commaIdx = sourceMapURL.indexOf(",");
    if (commaIdx < 0) throw new Error("malformed data: URI");
    const meta = sourceMapURL.slice(5, commaIdx);
    const payload = sourceMapURL.slice(commaIdx + 1);
    const isBase64 = /;base64/i.test(meta);
    const decoded = isBase64
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
    return JSON.parse(decoded);
  }
  // file:// URL
  if (sourceMapURL.startsWith("file://")) {
    const path = fileURLToPath(sourceMapURL);
    return JSON.parse(await readFile(path, "utf8"));
  }
  // http(s):// URL
  if (/^https?:\/\//.test(sourceMapURL)) {
    const res = await fetch(sourceMapURL);
    if (!res.ok) throw new Error(`fetch ${sourceMapURL} → ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  // Relative URL — resolve against scriptUrl
  if (scriptUrl.startsWith("file://")) {
    const scriptPath = fileURLToPath(scriptUrl);
    const slash = scriptPath.lastIndexOf("/");
    const dir = slash >= 0 ? scriptPath.slice(0, slash) : scriptPath;
    const abs = `${dir}/${sourceMapURL}`;
    return JSON.parse(await readFile(abs, "utf8"));
  }
  throw new Error(`unsupported sourceMapURL: ${sourceMapURL}`);
}
