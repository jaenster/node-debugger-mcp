type Level = "off" | "info" | "debug" | "trace";

const LEVELS: Record<Level, number> = { off: 0, info: 1, debug: 2, trace: 3 };

function parseLevel(): Level {
  const raw = (process.env.DEBUG_MCP ?? "info").toLowerCase();
  if (raw === "1" || raw === "true") return "debug";
  if (raw in LEVELS) return raw as Level;
  return "info";
}

const current = LEVELS[parseLevel()];

function write(level: Level, parts: unknown[]): void {
  if (LEVELS[level] > current) return;
  const ts = new Date().toISOString();
  const line = parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ");
  process.stderr.write(`[${ts}] [${level}] ${line}\n`);
}

export const log = {
  info: (...parts: unknown[]) => write("info", parts),
  debug: (...parts: unknown[]) => write("debug", parts),
  trace: (...parts: unknown[]) => write("trace", parts),
  error: (...parts: unknown[]) => write("info", ["ERROR:", ...parts]),
};
