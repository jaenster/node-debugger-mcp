// Source-map indexing for source-aware breakpoints + reverse-mapped frames.
//
// Note on coordinate systems:
//   - V8 / CDP / our internal types: line is 0-indexed, column is 0-indexed.
//   - @jridgewell/trace-mapping: line is 1-indexed, column is 0-indexed.
//
// Every conversion across the boundary is annotated.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve as pathResolve, dirname as pathDirname, isAbsolute } from "node:path";
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
      const rawIdx = entry.rawSources.indexOf(orig.source);
      const normalized = rawIdx >= 0 ? entry.normalizedSources[rawIdx]! : orig.source;
      return {
        url: normalized,
        line0: orig.line - 1, // → 0-indexed
        column0: orig.column,
      };
    } catch {
      return null;
    }
  }

  sourceContent(scriptId: string, sourceUrl: string): string | undefined {
    const entry = this.byScriptId.get(scriptId);
    if (!entry) return undefined;
    // Try to find the raw `sources[i]` that corresponds to the requested URL.
    for (let i = 0; i < entry.normalizedSources.length; i++) {
      if (
        entry.normalizedSources[i] === sourceUrl ||
        entry.rawSources[i] === sourceUrl ||
        absolutize(entry.normalizedSources[i] ?? "") === absolutize(sourceUrl)
      ) {
        try {
          return sourceContentFor(entry.traceMap, entry.rawSources[i]!) ?? undefined;
        } catch {
          return undefined;
        }
      }
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
  // 1. Exact match against the normalized absolute paths.
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === wantAbs) return i;
  }
  // 2. Suffix match against the raw or normalized — handles bundlers whose
  //    `sources[]` is something like `webpack:///./src/foo.ts` while the
  //    caller passed `src/foo.ts` or `/abs/path/src/foo.ts`.
  for (let i = 0; i < normalized.length; i++) {
    const norm = normalized[i] ?? "";
    if (norm.endsWith(wantAbs) || norm.endsWith(wantRaw)) return i;
    if (wantAbs.endsWith(norm) || wantRaw.endsWith(norm)) return i;
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
  // Apply sourceRoot if relative.
  if (sourceRoot && !/^([a-z]+:|\/)/.test(src)) {
    src = sourceRoot.endsWith("/") ? sourceRoot + src : `${sourceRoot}/${src}`;
  }
  // Strip well-known bundler prefixes.
  src = src.replace(/^webpack:\/\/\/?\.?\//, "");
  src = src.replace(/^webpack:\/\//, "");
  if (src.startsWith("file://")) {
    try {
      return fileURLToPath(src);
    } catch {
      return src.slice(7);
    }
  }
  if (isAbsolute(src)) return src;
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
