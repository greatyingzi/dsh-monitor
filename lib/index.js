/**
 * dsh-monitor v1.1 — delivery hardening modeled on dsh-schedule and dsh-tool-jobs:
 * owner id resolved live, archived owners disarmed, flush acknowledgement before
 * cursor advance, wake budget + delivery cooldown, parked-notice recovery,
 * and timers detached from the arming agent via agents.withoutInitiator().
 */
import z from "@deepseek-ai/schemastery";
import { createUserMessage, boundContextSummary } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

const execFileAsync = promisify(execFile);

function expandHome(p) {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolvePath(homedir(), p.slice(2));
  return p;
}

const name = "dsh-monitor";
const inject = ["tools", "systemPrompt", "agents", "sessions"];

const Config = z.object({
  maxNoticeBytes: z.number().min(64).default(4096),
  defaultPollIntervalMs: z.number().min(100).default(2000),
  minDeliveryIntervalMs: z.number().min(100).default(5000),
  maxConsecutiveWakes: z.number().min(0).default(2),
  parkedNoticeTimeoutMs: z.number().min(1000).default(30000)
});

function fingerprint(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function makeWatcher(spec) {
  return {
    ...spec,
    cursor: null,
    stopped: false,
    timer: null,
    recoverTimer: null,
    delivered: 0,
    lastDeliveredAt: 0,
    lastFingerprint: null,
    consecutiveWakes: 0,
    parked: [],
    inFlight: false
  };
}

function readFileDelta(path, fromOffset) {
  let size = 0;
  try { size = statSync(path).size; } catch { return { lines: [], offset: fromOffset }; }
  if (size === fromOffset) return { lines: [], offset: size };
  const start = fromOffset === null || size < fromOffset ? 0 : fromOffset;
  const buf = readFileSync(path);
  const text = buf.subarray(start).toString("utf8");
  const lines = [];
  let cursor = start;
  for (const raw of text.split("\n")) {
    const endOffset = Math.min(cursor + Buffer.byteLength(raw) + 1, size);
    const line = raw.trim();
    if (line) {
      let content = line;
      try {
        const rec = JSON.parse(line);
        content = typeof rec?.content === "string" ? rec.content : line;
      } catch {}
      lines.push({ raw: line, content, endOffset });
    }
    cursor = endOffset;
  }
  return { lines, offset: size };
}

async function runCommand(cmd, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", cmd], {
      cwd: cwd ?? process.cwd(), timeout: 10000, maxBuffer: 16 * 1024 * 1024
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", ok: true };
  } catch (error) {
    return { stdout: "", stderr: String(error?.message ?? error), ok: false };
  }
}

function noticeFor(watcher, content) {
  const head = "[monitor " + (watcher.name ?? watcher.id) + "] " + content;
  const summary = boundContextSummary(head);
  return { text: summary, summary };
}

function apply(ctx, config) {
  const defaultPollMs = config.defaultPollIntervalMs ?? 2000;
  const minDeliveryMs = config.minDeliveryIntervalMs ?? 5000;
  const wakeBudget = config.maxConsecutiveWakes ?? 2;
  const parkedTimeoutMs = config.parkedNoticeTimeoutMs ?? 30000;
  const watchers = new Map();
  let seq = 0;

  ctx.systemPrompt.section({
    name: "tool:monitor",
    order: 120,
    text: "You can arm persistent watchers with the monitor tool. A watcher delivers a message into this session whenever new content appears in its source — you are woken even while idle. Do not busy-poll a source you already watch; monitor_list shows what is armed, and monitor_stop disarms a watcher you no longer need."
  });

  ctx.on("agent/inbox/claimed", ({ agent, message }) => {
    if (message?.source?.kind !== "user") return;
    for (const w of watchers.values()) if (w.ownerId === agent?.id) w.consecutiveWakes = 0;
  });

  function resolveAgent(ownerId) {
    if (!ownerId) return undefined;
    return ctx.get("agents")?.get(ownerId);
  }
  function isArchived(ownerId) {
    return ctx.get("workspaceRegistry")?.archivedSessionIds?.includes(ownerId) ?? false;
  }
  function flush(session) {
    const sessions = ctx.get("sessions");
    if (typeof sessions?.flush !== "function") return Promise.resolve(true);
    return Promise.resolve(sessions.flush(session));
  }
  function withoutInitiator(fn) {
    const agents = ctx.get("agents");
    if (typeof agents?.withoutInitiator === "function") agents.withoutInitiator(fn);
    else fn();
  }

  function stopWatcher(id) {
    const w = watchers.get(id);
    if (!w) return false;
    w.stopped = true;
    if (w.timer) w.timer();
    if (w.recoverTimer) w.recoverTimer();
    watchers.delete(id);
    return true;
  }

  function recoverParked(w) {
    if (w.stopped || w.parked.length === 0) return;
    const agent = resolveAgent(w.ownerId);
    if (!agent || agent.status !== "idle") return;
    for (const notice of [...w.parked]) {
      if (agent.inbox?.nextStep?.some((m) => m.id === notice.id)) {
        agent.inbox.remove(notice.id);
        agent.followup(notice.message);
        w.consecutiveWakes += 1;
      }
      w.parked.splice(w.parked.indexOf(notice), 1);
    }
  }

  function armWatcher(spec, ownerId) {
    const id = "monitor-" + (++seq);
    const watcher = makeWatcher({ ...spec, id, ownerId });
    watchers.set(id, watcher);
    if (watcher.source === "file") {
      watcher.path = expandHome(watcher.path);
      try { watcher.cursor = statSync(watcher.path).size; } catch { watcher.cursor = 0; }
    }

    const deliver = async (w, content) => {
      if (w.stopped) return false;
      const now = Date.now();
      if (w.lastDeliveredAt !== 0 && now - w.lastDeliveredAt < minDeliveryMs) return false;
      const fp = fingerprint(content);
      if (fp === w.lastFingerprint) return false;

      const agent = resolveAgent(w.ownerId);
      if (!agent) {
        ctx.logger.warn("dsh-monitor " + w.id + ": owner session " + w.ownerId + " is not live; disarming");
        stopWatcher(w.id);
        return false;
      }
      if (isArchived(w.ownerId)) {
        ctx.logger.warn("dsh-monitor " + w.id + ": owner session " + w.ownerId + " is archived; disarming");
        stopWatcher(w.id);
        return false;
      }

      const { text, summary } = noticeFor(w, content);
      const message = createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "dsh-monitor", form: "notice", summary }
      });

      if (agent.status === "idle" && w.consecutiveWakes < wakeBudget) {
        agent.followup(message);
        w.consecutiveWakes += 1;
      } else {
        agent.inject(message);
        w.parked.push({ message, id: message.id, at: now });
        if (w.parked.length > 16) w.parked.shift();
      }

      let acknowledged;
      try { acknowledged = await flush(agent.session); }
      catch (error) {
        ctx.logger.error("dsh-monitor " + w.id + ": session flush failed: " + String(error?.message ?? error));
        acknowledged = false;
      }
      if (!acknowledged) {
        ctx.logger.warn("dsh-monitor " + w.id + ": delivery not acknowledged; cursor will not advance");
        return false;
      }
      w.lastDeliveredAt = now;
      w.lastFingerprint = fp;
      w.delivered += 1;
      return true;
    };

    const tick = async () => {
      if (watcher.stopped || watcher.inFlight) return;
      watcher.inFlight = true;
      try {
        recoverParked(watcher);
        if (watcher.stopped) return;
        if (watcher.source === "file") {
          const { lines } = readFileDelta(watcher.path, watcher.cursor);
          let cursor = watcher.cursor;
          for (const line of lines) {
            if (!(await deliver(watcher, line.content))) break;
            cursor = line.endOffset;
          }
          if (cursor > watcher.cursor) watcher.cursor = cursor;
        } else if (watcher.source === "command") {
          const { stdout } = await runCommand(watcher.command, watcher.cwd);
          const current = stdout.endsWith("\n") ? stdout : stdout + "\n";
          const prev = watcher.cursor ?? "";
          if (prev !== current) {
            const delta = current.startsWith(prev) ? current.slice(prev.length) : current;
            const trimmed = delta.trim();
            if (trimmed) { if (await deliver(watcher, trimmed)) watcher.cursor = current; }
            else watcher.cursor = current;
          }
        }
      } catch (error) {
        ctx.logger.error("dsh-monitor " + watcher.id + ": tick failed: " + String(error?.message ?? error));
      } finally {
        watcher.inFlight = false;
      }
    };

    const interval = Math.max(watcher.pollIntervalMs ?? defaultPollMs, 100);
    const timer = setInterval(() => withoutInitiator(() => void tick()), interval);
    watcher.timer = () => clearInterval(timer);
    const recoverTimer = setInterval(
      () => withoutInitiator(() => void recoverParked(watcher)),
      Math.min(parkedTimeoutMs, 10000)
    );
    watcher.recoverTimer = () => clearInterval(recoverTimer);
    ctx.effect(() => () => {
      if (!watcher.stopped) {
        watcher.stopped = true;
        clearInterval(timer);
        clearInterval(recoverTimer);
        watchers.delete(watcher.id);
      }
    });
    return watcher;
  }

  ctx.tools.register(defineTool({
    name: "monitor",
    description: "Arm a persistent watcher that wakes you when new messages arrive. Use source=file with an append-only NDJSON inbox path (each new line is delivered), or source=command with a shell command re-run on an interval (its output delta is delivered). Returns the watcher id; disarm with monitor_stop.",
    parameters: {
      source: { type: "string", required: true, enum: ["file", "command"], description: "file = watch an append-only ndjson inbox; command = poll a shell command output." },
      path: { type: "string", description: "Absolute path of the ndjson inbox file (required when source is file)." },
      command: { type: "string", description: "Shell command to poll (required when source is command)." },
      cwd: { type: "string", description: "Working directory for the command (command source only)." },
      poll_interval_ms: { type: "number", description: "Poll interval in ms (default " + defaultPollMs + ")." },
      name: { type: "string", description: "Short label shown in wake-up messages and monitor_list." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          source: { type: "string", required: true },
          description: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: "Monitor started (" + value.id + ", " + value.source + ": " + value.description + "). You will be woken when new messages arrive."
      }]
    },
    async execute(args, exec) {
      if (args.source === "file" && !args.path) throw new Error("monitor: source file requires a non-empty path");
      if (args.source === "command" && !args.command) throw new Error("monitor: source command requires a non-empty command");
      const watcher = armWatcher({
        source: args.source, path: args.path, command: args.command, cwd: args.cwd,
        pollIntervalMs: args.poll_interval_ms, name: args.name
      }, exec.agent?.id);
      return { id: watcher.id, source: watcher.source, description: watcher.source === "file" ? watcher.path : watcher.command };
    },
    presentCall: (args) => ({
      card: "generic",
      title: args.source === "file" ? "Watch inbox " + args.path : "Watch command " + args.command,
      kind: "execute"
    })
  }));

  ctx.tools.register(defineTool({
    name: "monitor_list",
    description: "List armed persistent watchers with their ids, sources, and delivery counts.",
    parameters: {},
    output: {
      schema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            source: { type: "string", required: true },
            description: { type: "string", required: true },
            delivered: { type: "integer", required: true }
          }
        }
      },
      render: (_args, watchersList) => [{
        type: "text",
        text: watchersList.length === 0
          ? "(no armed watchers)"
          : watchersList.map((w) => w.id + " [" + w.source + "] " + w.description + " (delivered " + w.delivered + ")").join("\n")
      }]
    },
    execute() {
      const visible = [];
      for (const w of watchers.values()) {
        visible.push({ id: w.id, source: w.source, description: w.source === "file" ? w.path : w.command, delivered: w.delivered });
      }
      return Promise.resolve(visible);
    },
    presentCall: () => ({ card: "generic", title: "List armed monitors", kind: "read" })
  }));

  ctx.tools.register(defineTool({
    name: "monitor_stop",
    description: "Disarm a persistent watcher by id (see monitor_list). Returns whether it was still armed.",
    parameters: { id: { type: "string", required: true, description: "Watcher id returned by monitor." } },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          stopped: { type: "boolean", required: true },
          id: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.stopped ? "Monitor " + value.id + " disarmed." : "No armed watcher " + value.id + "."
      }]
    },
    execute(args) {
      return Promise.resolve({ stopped: stopWatcher(args.id), id: args.id });
    },
    presentCall: (args) => ({ card: "generic", title: "Disarm monitor " + args.id, kind: "execute" })
  }));
}

export { Config, apply, inject, name };
