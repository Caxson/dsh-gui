/**
 * Dsh GUI host bridge — the desktop product as a DSH plugin.
 *
 * Mounted into the web profile via plugins/desktop.patch.yml. Provides:
 *  1. session/event → file/web activity snapshot (right panel 文件/浏览器 tabs);
 *  2. a shared, persistent PTY that BOTH the agent (via the `terminal_send`
 *     tool) and the right panel terminal use — the user sees every command the
 *     agent runs in the same terminal, Codex-style.
 *
 * Everything runs on the engine's existing loopback webserver; no kernel
 * changes, no external services.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { createRequire } from "node:module";
import { homedir } from "node:os";

export const name = "dsh-gui-bridge";
export const inject = ["tools"];

const require = createRequire(import.meta.url);
const MAX_ACTIVITIES = 200;
const URL_RE = /https?:\/\/[^\s"'<>()]+/g;
const PTY_OUT_MAX = 400; // ring-buffer chunks
const DEFAULT_SHELL = process.env.SHELL || "/bin/zsh";

/** Read a JSON request body. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function json(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

export function apply(ctx) {
  const activities = [];
  const calls = new Map();
  let cwd = null;

  // ── shared PTY (agent + panel) ──────────────────────────────────────────
  let ptyProcess = null;
  let outSeq = 0;
  const outLog = []; // { seq, data }
  let lastOutAt = 0;
  let activeCollector = null; // one in-flight terminal_send output sink

  const pushOut = (data) => {
    outLog.push({ seq: outSeq++, data });
    lastOutAt = Date.now();
    if (activeCollector) activeCollector(data);
    if (outLog.length > PTY_OUT_MAX) outLog.shift();
  };

  function ensurePty(spawnCwd) {
    if (ptyProcess) return true;
    try {
      const pty = require("node-pty");
      ptyProcess = pty.spawn(DEFAULT_SHELL, [], {
        name: "xterm-256color",
        cols: 120,
        rows: 32,
        cwd: spawnCwd || homedir(),
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch (err) {
      console.error("[dsh-gui-bridge] pty spawn failed:", err.message);
      return false;
    }
    ptyProcess.onData((d) => pushOut(d));
    ptyProcess.onExit(() => {
      ptyProcess = null;
      pushOut("\r\n\x1b[90m[terminal exited]\x1b[0m\r\n");
    });
    return true;
  }

  // ── activity capture (files / web) ──────────────────────────────────────
  const push = (activity) => {
    const entry = { at: Date.now(), ...activity };
    activities.push(entry);
    if (activities.length > MAX_ACTIVITIES) activities.shift();
    return entry;
  };

  const textOf = (content) => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block) => (block && block.type === "text" ? block.text : ""))
        .join("\n");
    }
    return "";
  };

  ctx.on("session/event", (session, event) => {
    const header = session?.header;
    if (header?.cwd) cwd = header.cwd;
    const data = event?.data;
    if (!data) return;

    if (event.type === "tool/call") {
      const name = data.name;
      const args = data.arguments ?? {};
      let activity = null;
      if (name === "str_replace_editor") {
        const cmd = args.command;
        if (cmd === "str_replace") {
          activity = { kind: "file", action: "edit", path: args.path, oldText: args.old_str ?? "", newText: args.new_str ?? "" };
        } else if (cmd === "create") {
          activity = { kind: "file", action: "create", path: args.path, newText: args.file_text ?? "" };
        } else if (cmd === "insert") {
          activity = { kind: "file", action: "insert", path: args.path, line: args.insert_line };
        }
      } else if (name === "write") {
        activity = { kind: "file", action: "write", path: args.file_path, newText: args.content ?? "" };
      } else if (name === "edit") {
        activity = { kind: "file", action: "edit", path: args.file_path };
      } else if (name === "web_search") {
        activity = { kind: "web", type: "search", query: args.query ?? "" };
      } else if (name === "web_fetch") {
        activity = { kind: "web", type: "fetch", url: args.url ?? "" };
      }
      if (activity) calls.set(data.callId, push(activity));
    } else if (event.type === "tool/result") {
      const callId = data.callId ?? data.message?.callId;
      const activity = calls.get(callId);
      if (!activity) return;
      calls.delete(callId);
      const text = textOf(data.message?.content);
      if (activity.kind === "web" && text) {
        activity.result = text.slice(0, 2000);
        activity.links = [...new Set(text.match(URL_RE) ?? [])].slice(0, 8);
      }
    }
  });

  // ── terminal_send tool: run a command in the SHARED terminal ────────────
  ctx.tools.register(defineTool({
    name: "terminal_send",
    description:
      "Run a command in the shared terminal session — the same terminal shown in the right panel of the desktop app, where the user can watch live output. Prefer this for long-running or interactive commands; use the bash tool for ordinary one-shot commands.",
    parameters: {
      command: {
        type: "string",
        required: true,
        description: "The command to run in the shared terminal.",
      },
      timeoutMs: {
        type: "number",
        description: "Max time to wait for output to settle, in milliseconds. Default 60000.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { content: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: value.content }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const sessionCwd = exec?.agent?.session?.header?.cwd;
      if (!ensurePty(sessionCwd)) return { content: "[terminal unavailable]" };
      const started = Date.now();
      const timeout = args.timeoutMs ?? 60000;
      let buf = "";
      let last = Date.now();
      activeCollector = (data) => {
        buf += data;
        last = Date.now();
      };
      try {
        ptyProcess.write(`${args.command}\r`);
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            const now = Date.now();
            const quiet = buf.length > 0 && now - last > 700;
            if (quiet || now - started > timeout) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      } finally {
        activeCollector = null;
      }
      return { content: buf };
    },
  }));

  // ── HTTP routes (loopback only) ─────────────────────────────────────────
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => {
      const disposers = [
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/state",
          handler: async (_req, res) => json(res, { cwd, home: homedir(), activities }),
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/open",
          handler: async (req, res) => {
            const body = await readBody(req).catch(() => ({}));
            if (!ensurePty(cwd)) return json(res, { ok: false }, 500);
            if (body.cols && body.rows) {
              try {
                ptyProcess.resize(body.cols, body.rows);
              } catch { /* ignore */ }
            }
            json(res, { ok: true, seq: outSeq });
          },
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/input",
          handler: async (req, res) => {
            const body = await readBody(req).catch(() => ({}));
            if (ptyProcess && typeof body.data === "string") ptyProcess.write(body.data);
            json(res, { ok: true });
          },
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/resize",
          handler: async (req, res) => {
            const body = await readBody(req).catch(() => ({}));
            if (ptyProcess && body.cols && body.rows) {
              try {
                ptyProcess.resize(body.cols, body.rows);
              } catch { /* ignore */ }
            }
            json(res, { ok: true });
          },
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/out",
          handler: async (req, res) => {
            const since = Number(new URL(req.url, "http://x").searchParams.get("since") ?? -1);
            const chunks = outLog.filter((c) => c.seq > since).map((c) => c.data);
            json(res, { seq: outSeq, chunks });
          },
        }),
      ];
      return () => disposers.forEach((d) => d());
    }, "dsh-gui-bridge: routes");
  });
}
