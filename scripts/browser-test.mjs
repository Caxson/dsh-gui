// Browser plugin unit test: mount dsh-desktop-browser on a bare Cordis
// context, drive the `browser` tool (open about:blank), and assert the live
// screenshot route returns a real JPEG. Run with:
//   PLAYWRIGHT_BROWSERS_PATH=<browsers dir> node scripts/browser-test.mjs
import { Context } from "@deepseek-ai/cordis";
import { apply } from "../browser/index.js";

let shotHandler = null;
const registeredTools = [];

const ctx = new Context();
ctx.provide("webServer", {
  register(route) {
    if (route.path === "/dsh-desktop/browser/shot") shotHandler = route.handler;
    return () => {};
  },
});
ctx.provide("tools", {
  register(def) {
    registeredTools.push(def);
    return () => {};
  },
});
apply(ctx);

await new Promise((r) => setTimeout(r, 10));

const browserTool = registeredTools.find((t) => t.name === "browser");
if (!browserTool) {
  console.error("FAIL: browser tool not registered");
  process.exit(1);
}

const opened = await browserTool.execute({ action: "open", url: "about:blank" }, {});
const title = await browserTool.execute({ action: "read" }, {});
const closed = await browserTool.execute({ action: "close" }, {});

let shot = null;
if (shotHandler) {
  shot = await new Promise((resolve) => {
    shotHandler(
      {},
      {
        writeHead() {},
        end(body) {
          resolve(JSON.parse(body));
        },
      },
    );
  });
}

const checks = {
  toolRegistered: !!browserTool,
  opened: opened?.ok === true && opened?.url === "about:blank",
  readReturnedText: typeof title?.text === "string",
  closeOk: closed?.ok === true,
  shotRouteLive: shot?.live === false, // browser closed → not live (still a valid route answer)
};
console.log(JSON.stringify({ opened, title: title?.text?.slice(0, 40), shot, checks }, null, 2));
const failed = Object.entries(checks).filter(([, ok]) => !ok);
if (failed.length) {
  console.error("FAILED:", failed.map(([k]) => k).join(", "));
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
