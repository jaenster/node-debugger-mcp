import { encode as toonEncode } from "@toon-format/toon";

export type Format = "toon" | "json";

let cachedFormat: Format | null = null;

export function getFormat(): Format {
  if (cachedFormat) return cachedFormat;
  const raw = (process.env.MCP_DEBUGGER_FORMAT ?? "toon").toLowerCase();
  cachedFormat = raw === "json" ? "json" : "toon";
  return cachedFormat;
}

export function encode(value: unknown, format: Format = getFormat()): string {
  if (format === "json") return JSON.stringify(value, null, 2);
  return toonEncode(value as never);
}

// For tools: wrap a structured value as MCP tool result content.
export function asToolResult(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: encode(value) }] };
}
