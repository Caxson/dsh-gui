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
import { listDirectory } from "./filetree.js";

export const name = "dsh-gui-bridge";
export const inject = ["tools", "llm"];

const require = createRequire(import.meta.url);
const MAX_ACTIVITIES = 200;
const URL_RE = /https?:\/\/[^\s"'<>()]+/g;
const PTY_OUT_MAX = 400; // ring-buffer chunks per pty
// Windows has no $SHELL and no /bin/zsh; PowerShell is the closest equivalent
// to what the terminal tab is for, with cmd.exe as the last resort.
const DEFAULT_SHELL =
  process.platform === "win32"
    ? "powershell.exe"
    : process.env.SHELL || "/bin/zsh";
const AGENT_PTY = "agent";
const PTY_ID_RE = /^[a-z0-9][a-z0-9-]{0,32}$/;
const SIDECHAT_MAX_TOKENS = 4096;
const MAX_BODY_BYTES = 1_000_000;
const CALLS_MAX = 400;

/**
 * Reject cross-origin requests to these loopback routes. A same-origin fetch
 * from the DSH web page carries Origin=own host; the native (main-process)
 * fetch carries no Origin at all. A foreign page's POST always carries a
 * foreign Origin — that is the blind-POST attack we block. Missing Origin is
 * allowed (trusted native caller); present-and-mismatched is rejected.
 */
function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.host || "");
  } catch {
    return false;
  }
}

/** Read a JSON request body, capped to guard against memory-DoS. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
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
      if (activity) {
        calls.set(data.callId, push(activity));
        // Bound the pairing map: unmatched calls (interrupted turns, errors
        // with no tool/result) would otherwise leak. Drop the oldest.
        if (calls.size > CALLS_MAX) calls.delete(calls.keys().next().value);
      }
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
    // Not concurrency-safe: it writes raw keystrokes into one shared PTY, so
    // the engine must serialize calls (two concurrent commands would interleave
    // in the same line). Output is read back by seq range, not a shared sink.
    async execute(args, exec) {
      const sessionCwd = exec?.agent?.session?.header?.cwd;
      const entry = ensurePty(AGENT_PTY, sessionCwd);
      if (!entry) return { content: "[terminal unavailable]" };
      const started = Date.now();
      const timeout = args.timeoutMs ?? 60000;
      // Read this command's output from the ring buffer by seq, so it never
      // depends on a shared collector another call could clobber.
      const fromSeq = entry.outSeq;
      const collect = () =>
        entry.outLog.filter((c) => c.seq >= fromSeq).map((c) => c.data).join("");
      let lastLen = 0;
      let last = Date.now();
      entry.proc.write(`${args.command}\r`);
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          const len = collect().length;
          if (len !== lastLen) {
            lastLen = len;
            last = Date.now();
          }
          const now = Date.now();
          const quiet = len > 0 && now - last > 700;
          if (quiet || now - started > timeout) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
      return { content: collect() };
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
      // Reject cross-origin callers before any side effect / data read.
      const guard = (handler) => async (req, res) => {
        if (!sameOrigin(req)) return json(res, { error: "forbidden" }, 403);
        return handler(req, res);
      };
      const disposers = [
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/state",
          handler: guard(async (_req, res) => json(res, { cwd, home: homedir(), activities })),
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/files/list",
          handler: guard(async (req, res) => {
            const body = await readBody(req).catch(() => ({}));
            const rows = await listDirectory(cwd, String(body.path ?? ""), {
              showAll: body.showAll === true,
            });
            if (rows === null) return json(res, { error: "路径不存在或不在工作区内" }, 400);
            json(res, { ...rows, root: cwd });
          }),
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/open",
          handler: guard(async (req, res) => {
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
          }),
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/input",
          handler: guard(async (req, res) => {
            const body = await readBody(req).catch(() => ({}));
            const id = ptyIdOf(body.id);
            const entry = id === null ? undefined : ptys.get(id);
            if (entry && typeof body.data === "string") entry.proc.write(body.data);
            json(res, { ok: true });
          }),
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/resize",
          handler: guard(async (req, res) => {
            const body = await readBody(req).catch(() => ({}));
            const id = ptyIdOf(body.id);
            const entry = id === null ? undefined : ptys.get(id);
            if (entry && body.cols && body.rows) {
              try {
                entry.proc.resize(body.cols, body.rows);
              } catch { /* ignore */ }
            }
            json(res, { ok: true });
          }),
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/close",
          handler: guard(async (req, res) => {
            const body = await readBody(req).catch(() => ({}));
            const id = ptyIdOf(body.id);
            // The agent terminal outlives its tab: the model may still use it.
            if (id !== null && id !== AGENT_PTY) closePty(id);
            json(res, { ok: true });
          }),
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/terminal/out",
          handler: guard(async (req, res) => {
            const params = new URL(req.url, "http://x").searchParams;
            const id = ptyIdOf(params.get("id") ?? undefined);
            const since = Number(params.get("since") ?? -1);
            const entry = id === null ? undefined : ptys.get(id);
            if (!entry) return json(res, { seq: 0, chunks: [] });
            const chunks = entry.outLog.filter((c) => c.seq > since).map((c) => c.data);
            json(res, { seq: entry.outSeq, chunks });
          }),
        }),
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/sidechat",
          handler: guard(handleSidechat),
        }),
      ];
      return () => disposers.forEach((d) => d());
    }, "dsh-gui-bridge: routes");
  });
}
