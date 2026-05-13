import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { z } from "zod";
import { asToolResult } from "../encoding.js";
import { Session } from "../session.js";
import { sessions } from "../session-manager.js";
import { DEFAULT_PERSIST_FILENAME, loadPersisted } from "../persistence.js";

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    "debug_launch",
    {
      title: "debug_launch",
      description:
        "Spawn a Node.js script (or arbitrary command like `npm run start`) under the V8 inspector and attach. By default the target is paused at entry (stopOnEntry=true). With followChildren='noBreak' (default), every Node descendant of the spawned process also opens an inspector and is auto-attached as an `auto` session — covers `npm`/`pnpm`/`tsx watch`/`child_process.fork` flows. Returns the root session id and initial pause snapshot.",
      inputSchema: {
        script: z.string().optional().describe("Path to the .js/.cjs/.mjs file to run (mutually exclusive with `command`)."),
        command: z.array(z.string()).optional().describe("[bin, ...args] to spawn instead of `node <script>`. Inspector is injected via NODE_OPTIONS."),
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        stopOnEntry: z.boolean().optional().default(true),
        nodeBinary: z.string().optional().default("node"),
        followChildren: z.enum(["off", "noBreak", "break"]).optional().default("noBreak"),
        pauseOnUnhandledRejection: z.boolean().optional().default(false).describe("If true, registers process.on('unhandledRejection') → debugger; in every Node descendant's main thread via the bootstrap shim. Must be set at launch — cannot be enabled after attach. Does NOT propagate into worker threads (workers have their own execArgv)."),
        loadPersistedBreakpoints: z.boolean().optional().default(false).describe("If true, load BPs from .node-debugger-mcp.json in cwd after the session attaches. Implicit when the file's `autoLoad` is true."),
        persistPath: z.string().optional().describe("Override the default .node-debugger-mcp.json path for loading."),
      },
    },
    async (args) => {
      const id = sessions.mintId();
      const onAutoChild = async (wsUrl: string) => {
        const parent = sessions.get(id);
        if (!parent) return;
        const childId = sessions.mintId("c");
        try {
          const child = await Session.attachAuto(childId, parent, wsUrl);
          if ("skipped" in child) return; // wrapper (npm/pnpm/yarn) — already disconnected inside
          sessions.add(child);
        } catch (e) {
          // Auto-attach can fail (race against process exit, target taken).
          // Logged inside; nothing more to do.
        }
      };
      const session = await Session.launch(id, args, onAutoChild);
      sessions.add(session);
      if (args.stopOnEntry !== false) {
        await session.waitForNextPause(2000);
      }

      // Persisted breakpoint loading is opt-in: either the launch arg or the
      // file's `autoLoad: true` triggers it.
      const persistPath = pathResolve(
        args.cwd ?? process.cwd(),
        args.persistPath ?? DEFAULT_PERSIST_FILENAME,
      );
      let shouldLoad = !!args.loadPersistedBreakpoints;
      if (!shouldLoad && existsSync(persistPath)) {
        try {
          const parsed = JSON.parse(readFileSync(persistPath, "utf8"));
          if (parsed?.autoLoad === true) shouldLoad = true;
        } catch {
          // ignore — load step will surface a clearer error
        }
      }
      if (shouldLoad) {
        const r = await loadPersisted(session, persistPath);
        return asToolResult({
          ...(session.snapshot()),
          persistedBreakpoints: r,
        });
      }

      return asToolResult(session.snapshot());
    },
  );

  server.registerTool(
    "debug_run_tests",
    {
      title: "debug_run_tests",
      description:
        "Launch `node --test [pattern...]` under the debugger. Equivalent to debug_launch with command:['node','--test',...] plus convenience setup: when pauseOnFailure=true (default), pre-installs an exception breakpoint filtered to AssertionError so any `assert.*` failure pauses execution at the throw site. Use with node:test (Node's built-in test runner). For Jest/Vitest, use debug_launch with the appropriate command instead.",
      inputSchema: {
        pattern: z.array(z.string()).optional().describe("File patterns / paths to pass to `node --test`. Defaults to Node's auto-discovery (test/, **/*.test.js, etc)."),
        cwd: z.string().optional(),
        bail: z.boolean().optional().default(false).describe("Stop on first failure (passes --test-force-exit + sets bail in TEST options)."),
        pauseOnFailure: z.boolean().optional().default(true).describe("Pre-install an exception breakpoint filtered to AssertionError so assertion failures pause at the throw site."),
        stopOnEntry: z.boolean().optional().default(false).describe("Pause before the test runner starts. Useful when you want to set BPs in test files before they execute."),
      },
    },
    async ({ pattern, cwd, bail, pauseOnFailure, stopOnEntry }) => {
      const id = sessions.mintId();
      const args = ["--test"];
      if (bail) args.push("--test-force-exit");
      if (pattern && pattern.length > 0) args.push(...pattern);

      const onAutoChild = async (wsUrl: string) => {
        const parent = sessions.get(id);
        if (!parent) return;
        const childId = sessions.mintId("c");
        try {
          const child = await Session.attachAuto(childId, parent, wsUrl);
          if ("skipped" in child) return;
          sessions.add(child);
        } catch (e) {
          /* logged inside */
        }
      };

      const session = await Session.launch(
        id,
        {
          command: ["node", ...args],
          cwd,
          stopOnEntry: stopOnEntry ?? false,
          followChildren: "noBreak",
          // Apply BEFORE the target resumes — node:test's assertion failure
          // can fire within ~30ms of launch, faster than a post-launch
          // setExceptionPause can race in.
          ...(pauseOnFailure !== false
            ? { exceptionPause: { state: "all" as const, filter: ["AssertionError"] } }
            : {}),
        },
        onAutoChild,
      );
      sessions.add(session);

      if (stopOnEntry) {
        await session.waitForNextPause(2000);
      }

      return asToolResult({
        ...session.snapshot(),
        runnerArgs: args,
        pauseOnFailure: pauseOnFailure ?? true,
      });
    },
  );

  server.registerTool(
    "debug_attach",
    {
      title: "debug_attach",
      description:
        "Attach to an already-running Node.js process via its V8 inspector. Pass `url` (e.g. ws://127.0.0.1:9229/<uuid>) for a direct connection; or `host`+`port` to discover the target via http://host:port/json/list; or `pid` to send SIGUSR1 (POSIX only) and discover the inspector on the default port. If the target was started with --inspect-brk, the runtime is immediately released.",
      inputSchema: {
        host: z.string().optional(),
        port: z.number().int().positive().optional(),
        url: z.string().optional(),
        pid: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const id = sessions.mintId("a");
      try {
        const session = await Session.attach(id, args);
        sessions.add(session);
        // Give the runtime a moment to emit scripts and any initial pause.
        await session.waitForNextPause(500);
        return asToolResult(session.snapshot());
      } catch (e) {
        return asToolResult({
          error: String(e),
          hint: "If your IDE has a debugger attached to this process, detach it first — Node's inspector allows only one CDP client at a time.",
        });
      }
    },
  );

  server.registerTool(
    "debug_status",
    {
      title: "debug_status",
      description:
        "Report a session's current state: running, paused (with last pause snapshot), or terminated. Omits sessionId when there is only one session.",
      inputSchema: {
        sessionId: z.string().optional(),
      },
    },
    async ({ sessionId }) => {
      const session = sessions.resolve(sessionId);
      if (!session) {
        return asToolResult({
          error: sessionId
            ? `no session with id '${sessionId}'`
            : "no active session (or multiple — pass sessionId)",
          available: sessions.list().map((s) => s.id),
        });
      }
      return asToolResult(session.snapshot());
    },
  );

  server.registerTool(
    "debug_list_sessions",
    {
      title: "debug_list_sessions",
      description:
        "List active debug sessions. By default hides 'wrapper' sessions (npm-cli.js / pnpm / yarn etc.) since they're noise — set includeWrappers:true to see them. Each session's snapshot includes parent/child links, pid, cmdline, status, and last pauseState.",
      inputSchema: {
        includeWrappers: z.boolean().optional().default(false),
      },
    },
    async ({ includeWrappers }) => {
      const all = sessions.list();
      const visible = includeWrappers ? all : all.filter((s) => !s.isWrapper);
      const hiddenCount = all.length - visible.length;
      return asToolResult({
        sessions: visible.map((s) => s.snapshot()),
        ...(hiddenCount > 0 ? { hiddenWrappers: hiddenCount } : {}),
      });
    },
  );

  server.registerTool(
    "debug_disconnect",
    {
      title: "debug_disconnect",
      description:
        "Close the CDP connection for a session. If kill=true and the target was spawned by us, SIGTERM the child. If cascade=true (default), also disconnects any auto-attached child sessions.",
      inputSchema: {
        sessionId: z.string().optional(),
        kill: z.boolean().optional().default(false),
        cascade: z.boolean().optional().default(true),
      },
    },
    async ({ sessionId, kill, cascade }) => {
      const session = sessions.resolve(sessionId);
      if (!session) {
        return asToolResult({
          error: "no such session",
          available: sessions.list().map((s) => s.id),
        });
      }
      const cascaded: string[] = [];
      if (cascade !== false) {
        for (const childId of Array.from(session.childSessionIds)) {
          const c = sessions.get(childId);
          if (c) {
            try {
              await c.disconnect({ kill: false });
            } catch {
              // ignore
            }
            sessions.remove(c.id);
            cascaded.push(c.id);
          }
        }
      }
      await session.disconnect({ kill });
      sessions.remove(session.id);
      return asToolResult({
        disconnected: session.id,
        killed: !!kill,
        cascaded,
      });
    },
  );
}
