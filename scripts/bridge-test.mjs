// Bridge logic unit test: mount dsh-desktop-bridge on a bare Cordis context
// with fake webServer + tools services, feed it the exact session/event shapes
// dsh produces, and assert the /state payload and the terminal_send tool.
import { Context } from "@deepseek-ai/cordis";
import { apply } from "../bridge/index.js";

let lastPayload = null;
let routeHandler = null;
const registeredTools = [];

const ctx = new Context();
ctx.provide("webServer", {
  register(route) {
    if (route.path === "/dsh-desktop/state") routeHandler = route.handler;
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

const session = { header: { cwd: "/tmp/workspace" } };

ctx.emit("session/event", session, {
  type: "tool/call",
  data: {
    callId: "c1",
    name: "str_replace_editor",
    arguments: { command: "str_replace", path: "/tmp/a.txt", old_str: "old line", new_str: "new line" },
  },
});
ctx.emit("session/event", session, {
  type: "tool/call",
  data: { callId: "c2", name: "web_search", arguments: { query: "deepseek harness" } },
});
ctx.emit("session/event", session, {
  type: "tool/result",
  data: {
    message: {
      callId: "c2",
      content: [{ type: "text", text: "Top result: https://example.com/dsh some text" }],
    },
  },
});

// terminal_send tool: registered + actually executes in the shared PTY
const termTool = registeredTools.find((t) => t.name === "terminal_send");
if (!termTool) {
  console.error("FAIL: terminal_send tool not registered");
  process.exit(1);
}
const termResult = await termTool.execute(
  { command: "echo TERM_UNIT_OK" },
  { agent: { session: { header: { cwd: "/tmp/workspace" } } } },
);

routeHandler({}, {
  writeHead() {},
  end(body) {
    lastPayload = JSON.parse(body);
  },
});

const webItem = lastPayload.activities.find((a) => a.kind === "web");
const fileItem = lastPayload.activities.find((a) => a.kind === "file");
const checks = {
  cwd: lastPayload.cwd === "/tmp/workspace",
  fileActivity:
    fileItem?.action === "edit" &&
    fileItem?.oldText === "old line" &&
    fileItem?.newText === "new line",
  webActivity: webItem?.query === "deepseek harness",
  webResultAttached: webItem?.links?.includes("https://example.com/dsh"),
  terminalToolRegistered: !!termTool,
  terminalToolExecuted: String(termResult?.content ?? "").includes("TERM_UNIT_OK"),
};
console.log(JSON.stringify(checks, null, 2));
const failed = Object.entries(checks).filter(([, ok]) => !ok);
if (failed.length) {
  console.error("FAILED:", failed.map(([k]) => k).join(", "));
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
