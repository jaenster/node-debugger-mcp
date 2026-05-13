import { log } from "./log.js";

// stdio MCP uses stdout for JSON-RPC. Any stray write to stdout from our code
// or accidentally console.log corrupts the protocol. This guard wraps
// process.stdout.write so that any write whose first byte isn't a JSON-RPC
// frame (starts with `{` or `[`, possibly preceded by content-length headers)
// is redirected to stderr with a loud warning.

const allowedPrefixes = ["{", "[", "Content-Length:"];

export function installStdoutGuard(): void {
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(
            typeof encodingOrCb === "string" ? encodingOrCb : "utf8",
          );
    const trimmed = text.trimStart();
    const ok = allowedPrefixes.some((p) => trimmed.startsWith(p));
    if (!ok) {
      log.error(
        "stdout-guard: dropped non-JSON-RPC stdout write:",
        JSON.stringify(text.slice(0, 200)),
      );
      const callback =
        typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (callback) callback();
      return true;
    }
    return realWrite(chunk as never, encodingOrCb as never, cb as never);
  }) as typeof process.stdout.write;
}
