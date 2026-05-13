// Persist a session's breakpoint set + exception-pause config + watches to a
// JSON file (.node-debugger-mcp.json by default) so a future launch can
// restore them. Auto-load is opt-in (`loadPersistedBreakpoints: true` on
// launch OR `autoLoad: true` in the file).
//
// File paths in the schema are repo-relative — resolved against the file's
// own directory at load time — so the file is portable across machines.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as pathResolve } from "node:path";
import type { Session, ExceptionPauseState } from "./session.js";
import { log } from "./util/log.js";

interface PersistedLineBp {
  kind: "line";
  file: string;
  line: number;
  column?: number;
  condition?: string;
  hitCount?: number;
}
interface PersistedLogpoint {
  kind: "logpoint";
  file: string;
  line: number;
  column?: number;
  expression: string;
  captureStack?: boolean;
}
type PersistedBp = PersistedLineBp | PersistedLogpoint;

interface PersistFile {
  version: 1;
  autoLoad?: boolean;
  breakpoints?: PersistedBp[];
  exceptionPause?: ExceptionPauseState;
  exceptionFilter?: string[];
  watches?: { expression: string }[];
}

export const DEFAULT_PERSIST_FILENAME = ".node-debugger-mcp.json";

export async function loadPersisted(
  session: Session,
  filePath: string,
): Promise<{ loaded: number; from: string } | { error: string }> {
  if (!existsSync(filePath)) return { error: `not found: ${filePath}` };
  let parsed: PersistFile;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as PersistFile;
  } catch (e) {
    return { error: `parse failed: ${String(e)}` };
  }
  if (parsed.version !== 1) {
    return { error: `unsupported version ${parsed.version}` };
  }
  const baseDir = dirname(filePath);
  let count = 0;

  if (parsed.exceptionPause && parsed.exceptionPause !== "none") {
    try {
      await session.setExceptionPause({
        state: parsed.exceptionPause,
        filter: parsed.exceptionFilter,
      });
    } catch (e) {
      log.error(`persist: setExceptionPause failed: ${String(e)}`);
    }
  }

  for (const bp of parsed.breakpoints ?? []) {
    const abs = isAbsolute(bp.file) ? bp.file : pathResolve(baseDir, bp.file);
    try {
      if (bp.kind === "line") {
        await session.setBreakpoint({
          file: abs,
          line: bp.line,
          column: bp.column,
          condition: bp.condition,
          hitCount: bp.hitCount,
        });
      } else if (bp.kind === "logpoint") {
        await session.setLogpoint({
          file: abs,
          line: bp.line,
          column: bp.column,
          expression: bp.expression,
          captureStack: bp.captureStack,
        });
      }
      count++;
    } catch (e) {
      log.error(`persist: failed to set BP ${bp.file}:${bp.line}: ${String(e)}`);
    }
  }

  for (const w of parsed.watches ?? []) {
    session.addWatch(w.expression);
  }

  log.info(`persist: loaded ${count} BP(s) from ${filePath}`);
  return { loaded: count, from: filePath };
}

export async function savePersisted(
  session: Session,
  filePath: string,
): Promise<{ saved: number; to: string }> {
  const baseDir = dirname(filePath);
  const bps: PersistedBp[] = [];
  for (const b of session.breakpoints.values()) {
    if (!b.file || b.line === undefined) continue;
    const rel = relative(baseDir, b.file) || b.file;
    if (b.kind === "line") {
      bps.push({
        kind: "line",
        file: rel,
        line: b.line,
        column: b.column,
        condition: b.condition,
        hitCount: b.hitCountThreshold,
      });
    } else if (b.kind === "logpoint" && b.expression) {
      bps.push({
        kind: "logpoint",
        file: rel,
        line: b.line,
        column: b.column,
        expression: b.expression,
      });
    }
  }

  const file: PersistFile = {
    version: 1,
    autoLoad: false,
    breakpoints: bps,
    exceptionPause: session.exceptionPause !== "none" ? session.exceptionPause : undefined,
    exceptionFilter: session.exceptionFilter ?? undefined,
    watches: Array.from(session.watches.values()).map((w) => ({ expression: w.expression })),
  };
  await writeFile(filePath, JSON.stringify(file, null, 2), "utf8");
  log.info(`persist: saved ${bps.length} BP(s) to ${filePath}`);
  return { saved: bps.length, to: filePath };
}
