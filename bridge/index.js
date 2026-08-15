/**
 * Dsh GUI host bridge — the desktop product as a DSH plugin.
 *
 * Mounted into the web profile via plugins/desktop.patch.yml. Provides:
 *  1. session/event → file/web activity snapshot (right panel 文件/浏览器 tabs);
 *  2. PTY sessions for the right panel's terminal tabs. The `agent` PTY is
 *     shared with the model's `terminal_send` tool (the user watches the agent
 *     type, Codex-style); extra terminal tabs get their own local PTYs.
 *  3. a side-chat completion stream (ephemeral chats in the right panel) via
 *     the engine's llm service and the deployment's default model.
 *
 * Everything runs on the engine's existing loopback webserver; no kernel
 * changes, no external services.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { BlockAssembler, createUserMessage, createAssistantMessage, deepFreeze } from "@deepseek-ai/dsh-llm";

export const name = "dsh-gui-bridge";
export const inject = ["tools", "llm"];

const require = createRequire(import.meta.url);
const MAX_ACTIVITIES = 200;
const URL_RE = /https?:\/\/[^\s"'<>()]+/g;
const PTY_OUT_MAX = 400; // ring-buffer chunks per pty
const DEFAULT_SHELL = process.env.SHELL || "/bin/zsh";
const AGENT_PTY = "agent";
const PTY_ID_RE = /^[a-z0-9][a-z0-9-]{0,32}$/;
const SIDECHAT_MAX_TOKENS = 4096;

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

  // ── PTY sessions (agent-shared + local tabs) ────────────────────────────
  /** id → { proc, outSeq, outLog: {seq, data}[] } */
  const ptys = new Map();
  let activeCollector = null; // one in-flight terminal_send output sink

  function ensurePty(id, spawnCwd, cols, rows) {
    const existing = ptys.get(id);
    if (existing) return existing;
    let proc;
    try {
      const pty = require("node-pty");
      proc = pty.spawn(DEFAULT_SHELL, [], {
        name: "xterm-256color",
        cols: cols || 120,
        rows: rows || 32,
        cwd: spawnCwd || homedir(),
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch (err) {
      console.error("[dsh-gui-bridge] pty spawn failed:", err.message);
      return null;
    }
    const entry = { proc, outSeq: 0, outLog: [] };
    const pushOut = (data) => {
      entry.outLog.push({ seq: entry.outSeq++, data });
      if (id === AGENT_PTY && activeCollector) activeCollector(data);
      if (entry.outLog.length > PTY_OUT_MAX) entry.outLog.shift();
    };
    proc.onData(pushOut);
    proc.onExit(() => {
      ptys.delete(id);
      // keep the tail visible on next open of the same id
    });
    ptys.set(id, entry);
    return entry;
  }

  function closePty(id) {
    const entry = ptys.get(id);
    if (!entry) return;
    ptys.delete(id);
    try {
      entry.proc.kill();
    } catch {
      /* already dead */
    }
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
      const entry = ensurePty(AGENT_PTY, sessionCwd);
      if (!entry) return { content: "[terminal unavailable]" };
      const started = Date.now();
      const timeout = args.timeoutMs ?? 60000;
      let buf = "";
      let last = Date.now();
      activeCollector = (data) => {
        buf += data;
        last = Date.now();
      };
      try {
        entry.proc.write(`${args.command}\r`);
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

  // ── side chat: one-shot streamed completion over the default model ──────
  async function handleSidechat(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch {
      json(res, { error: "invalid JSON body" }, 400);
      return;
    }
    const history = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
    if (history.length === 0 || typeof history[history.length - 1]?.text !== "string") {
      json(res, { error: "messages required" }, 400);
      return;
    }
    const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
    if (!selection?.provider || !selection?.model) {
      json(res, { error: "尚未配置默认模型（设置 → 模型）" }, 409);
      return;
    }
    const messages = history.map((m) =>
      m.role === "assistant"
        ? createAssistantMessage({ content: [{ type: "text", text: String(m.text) }] })
        : createUserMessage({
            content: [{ type: "text", text: String(m.text) }],
            source: { kind: "plugin", plugin: "dsh-gui-bridge" },
          }),
    );
    const abort = new AbortController();
    req.on("close", () => abort.abort());
    // NOTE: no sessionId — auxiliary calls stamped with a live session's id
    // get routed into that session's replay cursor and deadlock.
    const options = deepFreeze({
      provider: selection.provider,
      model: selection.model,
      messages,
      system:
        "你是 Dsh GUI 右侧面板里的轻量侧边聊天助手。回答简洁、直接、有用；用户用什么语言你就用什么语言。这是临时聊天，不涉及主会话的任务状态。",
      maxTokens: SIDECHAT_MAX_TOKENS,
      signal: abort.signal,
    });
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Transfer-Encoding": "chunked",
    });
    try {
      let wrote = false;
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream(options)) {
        assembler.push(chunk);
        if (chunk.type === "text-delta" && chunk.text !== "") {
          res.write(chunk.text);
          wrote = true;
        }
      }
      // Fallback for providers that only emit whole blocks (no deltas).
      if (!wrote) {
        const text = assembler
          .blocks()
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("");
        res.write(text);
      }
    } catch (err) {
      if (!res.writableEnded) res.write(`\n[出错了: ${err.message}]`);
    } finally {
      res.end();
    }
  }

  // ── HTTP routes (loopback only) ─────────────────────────────────────────
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => {
      const ptyIdOf = (raw) => {
        const id = typeof raw === "string" && raw !== "" ? raw : AGENT_PTY;
        return PTY_ID_RE.test(id) ? id : null;
      };
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
            const id = ptyIdOf(body.id);
            if (id === null) return json(res, { ok: false, error: "bad id" }, 400);
            const entry = ensurePty(id, cwd, body.cols, body.rows);
            if (!entry) return json(res, { ok: false }, 500);
            if (body.cols && body.rows) {
              try {
                entry.proc.resize(body.cols, body.rows);
              } catch { /* ignore */ }
            }
            json(res, { ok: true, seq: entry.outSeq });
          },
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/input",
          handler: async (req, res) => {
            const body = await readBody(req).catch(() => ({}));
            const id = ptyIdOf(body.id);
            const entry = id === null ? undefined : ptys.get(id);
            if (entry && typeof body.data === "string") entry.proc.write(body.data);
            json(res, { ok: true });
          },
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/resize",
          handler: async (req, res) => {
            const body = await readBody(req).catch(() => ({}));
            const id = ptyIdOf(body.id);
            const entry = id === null ? undefined : ptys.get(id);
            if (entry && body.cols && body.rows) {
              try {
                entry.proc.resize(body.cols, body.rows);
              } catch { /* ignore */ }
            }
            json(res, { ok: true });
          },
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/close",
          handler: async (req, res) => {
            const body = await readBody(req).catch(() => ({}));
            const id = ptyIdOf(body.id);
            // The agent terminal outlives its tab: the model may still use it.
            if (id !== null && id !== AGENT_PTY) closePty(id);
            json(res, { ok: true });
          },
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/out",
          handler: async (req, res) => {
            const params = new URL(req.url, "http://x").searchParams;
            const id = ptyIdOf(params.get("id") ?? undefined);
            const since = Number(params.get("since") ?? -1);
            const entry = id === null ? undefined : ptys.get(id);
            if (!entry) return json(res, { seq: 0, chunks: [] });
            const chunks = entry.outLog.filter((c) => c.seq > since).map((c) => c.data);
            json(res, { seq: entry.outSeq, chunks });
          },
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/sidechat",
          handler: handleSidechat,
        }),
      ];
      return () => disposers.forEach((d) => d());
    }, "dsh-gui-bridge: routes");
  });
}
