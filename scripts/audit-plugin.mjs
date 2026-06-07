#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(packageRoot, ".artifacts", "linux-desktop-plugin-audit.json");
const schema = "openclaw-linux-desktop-plugin-audit/v1";

function usage() {
  return `Usage:
  node scripts/audit-plugin.mjs [--output <path>]

Runs focused source-level linux_desktop plugin checks without starting a Gateway.`;
}

function parseArgs(argv) {
  const options = { output: defaultOutput };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--output") {
      const value = argv[(index += 1)];
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a value");
      }
      options.output = path.resolve(packageRoot, value);
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }
  return options;
}

function runSourceAudit() {
  const source = String.raw`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createLinuxDesktopTool,
  focusLinuxWindow,
  listLinuxWindows,
  readLinuxScreen,
} from "./src/linux-desktop-tool.ts";

const checks = {};
const tempDirs = [];
const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-linux-desktop-audit-"));
  tempDirs.push(dir);
  return dir;
}

function fakeApi(pluginConfig = {}, logger = undefined) {
  return {
    id: "linux-desktop",
    name: "linux-desktop",
    source: "audit",
    config: {},
    pluginConfig,
    runtime: { version: "audit" },
    logger: logger ?? { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
  };
}

function writeDesktopEntry(root, fileName, body) {
  const dir = path.join(root, "applications");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, ["[Desktop Entry]", ...body].join("\n"), "utf8");
  return filePath;
}

function fileSha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeUsbDevice(sysRoot) {
  const dir = path.join(sysRoot, "bus/usb/devices/1-1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "idVendor"), "1234\n", "utf8");
  fs.writeFileSync(path.join(dir, "idProduct"), "5678\n", "utf8");
  fs.writeFileSync(path.join(dir, "busnum"), "001\n", "utf8");
  fs.writeFileSync(path.join(dir, "devnum"), "002\n", "utf8");
  fs.writeFileSync(path.join(dir, "manufacturer"), "Audit Vendor\n", "utf8");
  fs.writeFileSync(path.join(dir, "product"), "Audit Device\n", "utf8");
  fs.writeFileSync(path.join(dir, "serial"), "must-not-leak\n", "utf8");
}

function writeScreenArtifact(relativePath) {
  const file = path.join(process.cwd(), relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, TEST_PNG);
  fs.writeFileSync(
    file + ".json",
    JSON.stringify(
      {
        kind: "openclaw.linux_desktop.screen_capture",
        version: 1,
        artifact: {
          path: relativePath,
          bytes: TEST_PNG.byteLength,
          dimensions: { width: 1, height: 1 },
        },
        capture: {
          target: "window",
          capturedAt: "2026-05-31T21-30-00Z",
          portal: { provider: "xdg-desktop-portal", interactive: true },
          consent: {
            required: true,
            mode: "xdg-desktop-portal-interactive",
            granted: true,
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

try {
  const entrySource = fs.readFileSync(path.join(process.cwd(), "index.ts"), "utf8");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "openclaw.plugin.json"), "utf8"),
  );
  assert.equal(manifest.id, "linux-desktop");
  assert.equal(manifest.name, "Linux Desktop");
  assert.deepEqual(manifest.contracts.tools, ["linux_desktop"]);
  assert.match(entrySource, /definePluginEntry\(/);
  assert.match(entrySource, /id: "linux-desktop"/);
  assert.match(entrySource, /name: "Linux Desktop"/);
  assert.match(entrySource, /registerTool\(/);
  assert.match(entrySource, /optional: true/);
  assert.match(entrySource, /name: "linux_desktop"/);
  assert.match(entrySource, /ctx\.sandboxed/);
  checks.registration = { status: "passed" };

  const root = tempDir();
  const xdgDataHome = path.join(root, "xdg-data-home");
  const sysRoot = path.join(root, "sys");
  fs.mkdirSync(path.join(sysRoot, "bus/usb/devices"), { recursive: true });
  const spotifyDesktopEntry = writeDesktopEntry(xdgDataHome, "spotify.desktop", [
    "Name=Spotify",
    "Exec=spotify %U",
    "Terminal=false",
    "Type=Application",
  ]);
  writeUsbDevice(sysRoot);

  const tool = createLinuxDesktopTool(fakeApi(), {
    platform: "linux",
    sysRoot,
    xdgDataHome,
    xdgDataDirs: [],
    env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" },
    homeDir: root,
  });

  const status = await tool.execute("audit", { action: "status" });
  assert.equal(status.details.tool, "linux_desktop");
  assert.equal(status.details.action, "status");
  assert.equal(status.details.enabledCapabilities.status, true);
  assert.equal(status.details.enabledCapabilities.appsLaunch, false);
  assert.equal(
    status.details.windowBackends.wayland.strategy,
    "unsupported-generic-window-control",
  );
  assert.equal(status.details.windowBackends.wayland.available, false);
  assert.deepEqual(status.details.windowBackends.wayland.safeAlternatives, [
    "screen.capture",
    "screen.read",
    "browser",
    "nodes",
    "owned-surfaces",
  ]);
  checks.status = { status: "passed", supported: status.details.supported };

  const apps = await tool.execute("audit", { action: "apps.list", maxResults: 5 });
  assert.equal(apps.details.action, "apps.list");
  assert.equal(apps.details.count, 1);
  assert.equal(apps.details.apps[0].id, "spotify.desktop");
  assert.equal(apps.details.apps[0].launcherTrust, "fingerprint-required");
  assert.equal(apps.details.apps[0].launchAllowed, false);
  assert.equal(JSON.stringify(apps).includes("Exec="), false);
  checks.appsList = { status: "passed", count: apps.details.count };

  let idOnlyLaunchError;
  try {
    const launchTool = createLinuxDesktopTool(
      fakeApi({
        actions: { appsLaunch: true },
        allowedAppIds: ["spotify.desktop"],
      }),
      {
        platform: "linux",
        sysRoot,
        xdgDataHome,
        xdgDataDirs: [],
        env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" },
        homeDir: root,
        runCommand: async () => ({ stdout: "", stderr: "" }),
      },
    );
    await launchTool.execute("audit", { action: "apps.launch", appId: "spotify.desktop" });
  } catch (error) {
    idOnlyLaunchError = error;
  }
  assert.equal(
    idOnlyLaunchError?.code,
    "LINUX_DESKTOP_APP_LAUNCHER_FINGERPRINT_REQUIRED",
  );

  const launched = [];
  const fingerprintLaunchTool = createLinuxDesktopTool(
    fakeApi({
      actions: { appsLaunch: true },
      allowedAppIds: ["spotify.desktop"],
      allowedAppLaunchers: [{ id: "spotify.desktop", sha256: fileSha256(spotifyDesktopEntry) }],
    }),
    {
      platform: "linux",
      sysRoot,
      xdgDataHome,
      xdgDataDirs: [],
      env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" },
      homeDir: root,
      runCommand: async (command, args) => {
        launched.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    },
  );
  const launchedApp = await fingerprintLaunchTool.execute("audit", {
    action: "apps.launch",
    appId: "spotify.desktop",
  });
  assert.equal(launchedApp.details.launched, true);
  assert.equal(launchedApp.details.app.launcherTrust, "fingerprint-match");
  assert.deepEqual(launched[0]?.command, "gio");
  checks.appLaunchFingerprint = {
    status: "passed",
    idOnlyCode: idOnlyLaunchError.code,
    launcherTrust: launchedApp.details.app.launcherTrust,
  };

  const usb = await tool.execute("audit", { action: "devices.usb", maxResults: 5 });
  assert.equal(usb.details.action, "devices.usb");
  assert.equal(usb.details.count, 1);
  assert.equal(usb.details.devices[0].serialPresent, true);
  assert.equal(usb.details.redaction.serialNumbers, "omitted");
  assert.equal(JSON.stringify(usb).includes("must-not-leak"), false);
  checks.devicesUsb = { status: "passed", count: usb.details.count };

  const fakeBin = path.join(tempDir(), "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const sentinel = path.join(fakeBin, "wmctrl-was-executed");
  const fakeWmctrl = path.join(fakeBin, "wmctrl");
  fs.writeFileSync(
    fakeWmctrl,
    ["#!/bin/sh", "touch " + JSON.stringify(sentinel), "printf 'fake wmctrl\\\\n'"].join("\n"),
    "utf8",
  );
  fs.chmodSync(fakeWmctrl, 0o755);
  const windowsFromFakePath = await listLinuxWindows({
    maxResults: 5,
    config: { windows: { enabled: true, allowX11: true } },
    host: {
      platform: "linux",
      env: {
        PATH: [fakeBin, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
        DISPLAY: ":99",
        XDG_SESSION_TYPE: "x11",
      },
      homeDir: root,
    },
  });
  assert.equal(windowsFromFakePath.action, "windows.list");
  assert.equal(fs.existsSync(sentinel), false);
  checks.backendPathHijack = {
    status: "passed",
    fakeHelperExecuted: false,
    available: windowsFromFakePath.available,
  };

  const waylandWindowsFromFakePath = await listLinuxWindows({
    maxResults: 5,
    config: { windows: { enabled: true, allowX11: true } },
    host: {
      platform: "linux",
      env: {
        PATH: [fakeBin, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
        DISPLAY: ":99",
        WAYLAND_DISPLAY: "wayland-0",
        XDG_SESSION_TYPE: "wayland",
      },
      homeDir: root,
    },
  });
  assert.equal(waylandWindowsFromFakePath.action, "windows.list");
  assert.equal(waylandWindowsFromFakePath.available, false);
  assert.equal(waylandWindowsFromFakePath.reason, "wayland unsupported");
  assert.equal(fs.existsSync(sentinel), false);
  let waylandFocusError;
  try {
    await focusLinuxWindow({
      windowId: "0x03c00007",
      config: {
        windows: {
          enabled: true,
          allowX11: true,
          allowedFocusClasses: ["spotify.Spotify"],
        },
      },
      host: {
        platform: "linux",
        env: {
          PATH: [fakeBin, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
          DISPLAY: ":99",
          WAYLAND_DISPLAY: "wayland-0",
          XDG_SESSION_TYPE: "wayland",
        },
        homeDir: root,
      },
    });
  } catch (error) {
    waylandFocusError = error;
  }
  assert.equal(waylandFocusError?.code, "LINUX_DESKTOP_WINDOWS_WAYLAND_UNSUPPORTED");
  assert.equal(fs.existsSync(sentinel), false);
  checks.waylandWindowsFailClosed = {
    status: "passed",
    listReason: waylandWindowsFromFakePath.reason,
    focusCode: waylandFocusError.code,
    fakeHelperExecuted: false,
  };

  let privilegedError;
  try {
    await tool.execute("audit", { action: "apps.launch", appId: "spotify.desktop" });
  } catch (error) {
    privilegedError = error;
  }
  assert.equal(privilegedError?.code, "LINUX_DESKTOP_ACTION_DISABLED");
  checks.failClosed = { status: "passed", code: privilegedError.code };

  let redactionError;
  try {
    await tool.execute("audit", {
      action: "apps.list",
      maxResults: [
        ["client", "secret"].join("_") + "='runtime-secret'",
        ["api", "Key"].join("") + '="plain-key"',
      ].join(" "),
    });
  } catch (error) {
    redactionError = error;
  }
  assert.equal(redactionError?.code, "LINUX_DESKTOP_INVALID_PARAMETER");
  assert.equal(JSON.stringify(redactionError).includes("runtime-secret"), false);
  assert.equal(JSON.stringify(redactionError).includes("plain-key"), false);
  assert.equal(JSON.stringify(redactionError).includes("[redacted]"), true);
  checks.quotedCredentialRedaction = { status: "passed", code: redactionError.code };

  const artifactPath =
    "output/linux-desktop-read-test/linux-desktop-window-2026-05-31T21-30-00Z.png";
  writeScreenArtifact(artifactPath);
  const screen = await readLinuxScreen({
    artifactPath,
    config: { screenRead: { enabled: true } },
  });
  assert.deepEqual(screen.content.map((block) => block.type), ["text", "image"]);
  assert.equal(screen.details.action, "screen.read");
  assert.equal(screen.details.artifact.path, artifactPath);
  assert.equal(screen.details.media.mediaUrl, artifactPath);
  assert.equal(JSON.stringify(screen).includes(os.homedir()), false);
  checks.screenRead = { status: "passed", contentTypes: screen.content.map((block) => block.type) };

  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  fs.rmSync(path.join(process.cwd(), "output/linux-desktop-read-test"), {
    recursive: true,
    force: true,
  });
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: packageRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(error?.message ?? error) });
    });
  });
}

function redactText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|sk-proj-[A-Za-z0-9_-]{8,}|(?:sess|ek)_[A-Za-z0-9._-]{8,})\b/gi, "[redacted]")
    .replace(/\/home\/[A-Za-z0-9._-]+(?:\/[^\s"'<>)]*)?/g, "[redacted-home]");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runSourceAudit();
  let payload;
  if (result.code === 0) {
    payload = JSON.parse(result.stdout);
  } else {
    payload = {
      ok: false,
      error: redactText(result.stderr || result.stdout || "linux_desktop audit failed"),
    };
  }
  const artifact = {
    schema,
    generatedAt: new Date().toISOString(),
    command: "node --import tsx <linux_desktop source audit>",
    ...payload,
  };
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  console.log(path.relative(packageRoot, options.output).split(path.sep).join("/"));
  if (!artifact.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(redactText(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
