import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { SKILL } from "./help.ts";

const route = (routeKey: string, method: "GET" | "POST", path: string) => ({ routeKey, method, path, auth: "agent" as const, capability: "api.routes.register" as const });

const manifest: PaperclipPluginManifestV1 = {
  id: "agent-computer",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Agent computer",
  description: "A browser per agent that keeps its logins. Watch it live from the Computers page, take over for logins and 2FA, and type passwords the agent never sees.",
  author: "Haseeb Azhar",
  categories: ["connector"],
  capabilities: [
    "agents.read", "companies.read", "secrets.read-ref", "http.outbound", "plugin.state.read", "plugin.state.write",
    "api.routes.register", "skills.managed", "events.emit", "instance.settings.register", "ui.page.register", "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  apiRoutes: [
    route("help", "GET", "/pc/help"),
    route("status", "GET", "/pc/status"),
    route("read", "GET", "/pc/read"),
    route("screenshot", "GET", "/pc/screenshot"),
    route("open", "POST", "/pc/open"),
    route("look", "POST", "/pc/look"),
    route("click", "POST", "/pc/click"),
    route("type", "POST", "/pc/type"),
    route("key", "POST", "/pc/key"),
    route("scroll", "POST", "/pc/scroll"),
    route("ask-for-help", "POST", "/pc/ask-for-help"),
    route("ask-for-password", "POST", "/pc/ask-for-password"),
    route("wait", "GET", "/pc/wait"),
    route("browsers", "GET", "/pc/browsers"),
    route("release", "POST", "/pc/release"),
    route("howtos", "GET", "/pc/howtos"),
    route("save-howto", "POST", "/pc/howtos"),
    route("forget-howto", "POST", "/pc/howtos/forget"),
    route("teach", "POST", "/pc/howtos/teach"),
  ],
  skills: [{ skillKey: "computer", displayName: "Agent computer", slug: "agent-computer", description: "Use a real browser that keeps your logins, and hand it to a person when needed.", markdown: SKILL }],
  ui: {
    slots: [
      { type: "settingsPage", id: "computer-settings", displayName: "Agent computer", exportName: "SettingsPage" },
      // A page, not an agent tab: this Paperclip's agent page shows no plugin tabs. /<company>/computer?agent=<id>
      { type: "page", id: "computers", displayName: "Computers", exportName: "ComputersPage", routePath: "computer" },
      { type: "sidebar", id: "computers-link", displayName: "Computers", exportName: "ComputersLink" },
    ],
  },
  instanceConfigSchema: {
    type: "object",
    required: ["computerUrl", "computerToken"],
    properties: {
      computerUrl: { type: "string", title: "Computer URL", description: "Where Paperclip reaches the agent computer, e.g. http://agent-computer:4100" },
      computerToken: { format: "secret-ref", title: "Computer token", description: "A Paperclip secret holding the computer's COMPUTER_TOKEN." },
      gatewayUrl: { type: "string", title: "Live screen gateway URL", description: "Where the plugin reads recorded steps from the gateway. Default http://agent-computer-gateway:4200" },
      sharedBrowsers: {
        type: "array", title: "Shared browsers",
        description: "Named browsers several agents use, one at a time (e.g. one logged into GoHighLevel).",
        items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, agents: { type: "array", items: { type: "string" } }, sites: { type: "array", items: { type: "string" } } }, required: ["id", "name"] },
      },
      sites: {
        type: "array", title: "Allowed sites per agent",
        description: "An agent listed here reaches only these sites (and their subdomains when written *.example.com). Agents not listed reach any site.",
        items: { type: "object", properties: { agentId: { type: "string" }, sites: { type: "array", items: { type: "string" } } }, required: ["agentId"] },
      },
    },
  },
};

export default manifest;
