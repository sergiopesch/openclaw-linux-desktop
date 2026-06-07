import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import { createLinuxDesktopTool } from "./src/linux-desktop-tool.js";

function registerLinuxDesktopTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLinuxDesktopTool(api, { workspaceDir: ctx.workspaceDir });
    },
    { optional: true, name: "linux_desktop" },
  );
}

export default definePluginEntry({
  id: "linux-desktop",
  name: "Linux Desktop",
  description:
    "Wayland-safe Linux desktop status, app inventory, USB inventory, app launch, media control, portal screenshots, and screen reading for OpenClaw.",
  register(api) {
    registerLinuxDesktopTool(api);
  },
});
