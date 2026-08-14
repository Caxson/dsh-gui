/**
 * Dsh GUI browser — a real, agent-drivable browser with a live view.
 *
 * Mounted via plugins/desktop.patch.yml. Launches a headless Chromium
 * (Playwright) on first use, registers the `browser` tool so the agent can
 * open pages / click / type / navigate, and exposes the current viewport as a
 * JPEG stream for the right panel's 浏览器 tab.
 *
 * The Chromium binary is found through PLAYWRIGHT_BROWSERS_PATH (the desktop
 * shell sets it to the bundled browsers dir; in dev it falls back to the
 * standard Playwright cache).
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const name = "dsh-gui-browser";
export const inject = ["tools"];

const PROFILE_DIR = join(tmpdir(), "dsh-gui-browser-profile");
const VIEWPORT = { width: 1024, height: 640 };

function json(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

export function apply(ctx) {
  let context = null;
  let page = null;

  async function ensureBrowser() {
    if (page && !page.isClosed()) return page;
    if (!context) {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: "chromium", // full CFT build, new-headless mode (no headless-shell needed)
        headless: true,
        viewport: VIEWPORT,
        args: ["--no-first-run", "--disable-background-timer-throttling"],
      });
    }
    page = context.pages()[0] ?? (await context.newPage());
    return page;
  }

  // ── browser tool: agent drives the real browser ─────────────────────────
  ctx.tools.register(defineTool({
    name: "browser",
    description:
      "Drive a real headless Chromium browser whose live view is shown in the right panel of the desktop app. Actions: open (navigate to a URL), click (click a CSS selector), type (fill a selector), back, reload, read (return current page text), close. Use for sites that need a real browser; prefer web_fetch for plain pages.",
    parameters: {
      action: {
        type: "string",
        required: true,
        description: "open | click | type | back | reload | read | close",
      },
      url: {
        type: "string",
        description: "Target URL for `open`.",
      },
      selector: {
        type: "string",
        description: "CSS selector for `click` / `type`.",
      },
      text: {
        type: "string",
        description: "Text to type for `type`.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          url: { type: "string" },
          title: { type: "string" },
          text: { type: "string" },
          error: { type: "string" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.error
            ? `browser error: ${value.error}`
            : value.url
              ? `browser: ${value.title ?? ""} — ${value.url}`
              : value.ok === false
                ? "browser: action failed"
                : "browser: ok",
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = args.action;
      try {
        const p = await ensureBrowser();
        switch (action) {
          case "open": {
            if (!args.url) return { ok: false, error: "url required" };
            await p.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
            return { ok: true, url: p.url(), title: await p.title() };
          }
          case "click": {
            await p.click(args.selector, { timeout: 10000 });
            return { ok: true, url: p.url() };
          }
          case "type": {
            await p.fill(args.selector, args.text ?? "");
            return { ok: true };
          }
          case "back": {
            await p.goBack({ timeout: 15000 });
            return { ok: true, url: p.url(), title: await p.title() };
          }
          case "reload": {
            await p.reload({ timeout: 20000 });
            return { ok: true, url: p.url(), title: await p.title() };
          }
          case "read": {
            const text = (await p.locator("body").innerText()).slice(0, 6000);
            return { ok: true, url: p.url(), text };
          }
          case "close": {
            if (context) await context.close();
            context = null;
            page = null;
            return { ok: true };
          }
          default:
            return { ok: false, error: `unknown action: ${action}` };
        }
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  }));

  // ── live viewport stream for the right panel ────────────────────────────
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => {
      const disposers = [
        httpCtx.webServer.register({
          kind: "exact",
          path: "/dsh-gui/browser/shot",
          handler: async (_req, res) => {
            if (!page || page.isClosed()) return json(res, { live: false });
            try {
              const buf = await page.screenshot({ type: "jpeg", quality: 55 });
              json(res, {
                live: true,
                jpeg: buf.toString("base64"),
                url: page.url(),
                title: await page.title(),
                ts: Date.now(),
              });
            } catch (err) {
              json(res, { live: false, error: err.message });
            }
          },
        }),
      ];
      return () => disposers.forEach((d) => d());
    }, "dsh-gui-browser: /dsh-gui/browser/shot route");
  });
}
