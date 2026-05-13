import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asToolResult } from "../encoding.js";
import { sessions } from "../session-manager.js";
import type { Session } from "../session.js";

type StepKind = "continue" | "step_over" | "step_into" | "step_out";

async function doStep(
  session: Session,
  kind: StepKind,
  waitForPause: boolean,
  timeoutMs: number,
): Promise<{ status: string; pause?: unknown }> {
  // Arm the wait BEFORE sending the resume/step command — otherwise a fast
  // breakpoint hit can fire before our listener is installed.
  const wait = waitForPause ? session.armPause() : null;

  switch (kind) {
    case "continue":
      await session.resume();
      break;
    case "step_over":
      await session.stepOver();
      break;
    case "step_into":
      await session.stepInto();
      break;
    case "step_out":
      await session.stepOut();
      break;
  }

  if (!wait) return { status: "running" };
  const pause = await wait(timeoutMs);
  if (pause === null) return { status: "running" };
  return { status: "paused", pause };
}

export function registerExecutionTools(server: McpServer): void {
  for (const kind of ["continue", "step_over", "step_into", "step_out"] as const) {
    const toolName = `debug_${kind}`;
    server.registerTool(
      toolName,
      {
        title: toolName,
        description:
          kind === "continue"
            ? "Resume execution. If waitForPause (default true), block until the next pause or timeoutMs (default 5000)."
            : `Step ${kind.split("_")[1]}. If waitForPause (default true), block until the resulting pause or timeoutMs (default 5000).`,
        inputSchema: {
          sessionId: z.string().optional(),
          waitForPause: z.boolean().optional().default(true),
          timeoutMs: z.number().int().positive().optional().default(5000),
        },
      },
      async ({ sessionId, waitForPause, timeoutMs }) => {
        const session = sessions.resolve(sessionId);
        if (!session) return asToolResult({ error: "no such session" });
        const out = await doStep(
          session,
          kind,
          waitForPause ?? true,
          timeoutMs ?? 5000,
        );
        return asToolResult(out);
      },
    );
  }

  server.registerTool(
    "debug_pause",
    {
      title: "debug_pause",
      description:
        "Send Debugger.pause to interrupt a running target. If already paused, returns the current snapshot without sending.",
      inputSchema: {
        sessionId: z.string().optional(),
      },
    },
    async ({ sessionId }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      if (session.pauseState) {
        return asToolResult({ status: "paused", pause: session.pauseState });
      }
      const wait = session.armPause();
      await session.pause();
      const pause = await wait(2000);
      if (pause === null) return asToolResult({ status: "running" });
      return asToolResult({ status: "paused", pause });
    },
  );

  server.registerTool(
    "debug_run_to_line",
    {
      title: "debug_run_to_line",
      description:
        "Resume execution until reaching file:line, then pause. Implemented as a one-shot breakpoint + continue + wait; the BP is removed whether it hits or times out. Session must be paused when called.",
      inputSchema: {
        sessionId: z.string().optional(),
        file: z.string(),
        line: z.number().int().nonnegative(),
        timeoutMs: z.number().int().positive().optional().default(10000),
      },
    },
    async ({ sessionId, file, line, timeoutMs }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.runToLine({ file, line, timeoutMs });
      if ("error" in res) return asToolResult(res);
      if ("status" in res) return asToolResult(res);
      return asToolResult({ status: "paused", pause: res });
    },
  );

  server.registerTool(
    "debug_restart_frame",
    {
      title: "debug_restart_frame",
      description:
        "Re-execute the top frame from the start with current variable state. CDP requires the frame be the top frame and not inside a generator/async iterator or have other live activations — errors otherwise. `mode` defaults to 'StepInto'.",
      inputSchema: {
        sessionId: z.string().optional(),
        mode: z.enum(["StepInto", "StepOver", "StepOut"]).optional().default("StepInto"),
      },
    },
    async ({ sessionId, mode }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.restartFrame({ mode });
      if ("error" in res) return asToolResult(res);
      return asToolResult({ status: "paused", pause: res });
    },
  );

  server.registerTool(
    "debug_wait_for_any_pause",
    {
      title: "debug_wait_for_any_pause",
      description:
        "Wait for ANY session (or any of the named sessions) to pause. Returns { sessionId, pause } for the first one that pauses. Useful when a parent process (e.g. `node --test`) spawns subprocess(es) where the actual interesting pauses happen.",
      inputSchema: {
        sessionIds: z.array(z.string()).optional().describe("Restrict to specific sessions; default = all current sessions."),
        timeoutMs: z.number().int().positive().optional().default(15000),
      },
    },
    async ({ sessionIds, timeoutMs }) => {
      // Snapshot the candidate set up front. New auto-sessions that appear
      // mid-wait will be picked up by our re-poll loop below — keeps this
      // honest about which sessions could matter.
      const targets = (sessionIds && sessionIds.length > 0)
        ? sessionIds.map((id) => sessions.get(id)).filter((s): s is NonNullable<typeof s> => !!s)
        : sessions.list();

      // Cheap: any already-paused?
      for (const s of targets) {
        if (s.pauseState) {
          return asToolResult({ sessionId: s.id, status: "paused", pause: s.pauseState });
        }
      }

      const deadline = Date.now() + (timeoutMs ?? 15000);
      // Re-poll every 100ms; cheap because pauseState is just a memory check.
      // Auto-sessions spawned after we started are included in each iteration.
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const current = (sessionIds && sessionIds.length > 0)
          ? sessionIds.map((id) => sessions.get(id)).filter((s): s is NonNullable<typeof s> => !!s)
          : sessions.list();
        for (const s of current) {
          if (s.pauseState) {
            return asToolResult({ sessionId: s.id, status: "paused", pause: s.pauseState });
          }
        }
      }
      return asToolResult({ status: "running" });
    },
  );

  server.registerTool(
    "debug_wait_for_pause",
    {
      title: "debug_wait_for_pause",
      description:
        "Long-poll for the next pause on a session. Returns immediately if already paused.",
      inputSchema: {
        sessionId: z.string().optional(),
        timeoutMs: z.number().int().positive().optional().default(10000),
      },
    },
    async ({ sessionId, timeoutMs }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      if (session.pauseState) {
        return asToolResult({ status: "paused", pause: session.pauseState });
      }
      const pause = await session.armPause()(timeoutMs ?? 10000);
      if (pause === null) return asToolResult({ status: "running" });
      return asToolResult({ status: "paused", pause });
    },
  );
}
