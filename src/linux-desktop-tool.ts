import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type LinuxDesktopPluginConfig = {
  actions?: {
    status?: boolean;
    appsList?: boolean;
    appsLaunch?: boolean;
    devicesUsb?: boolean;
    windowsList?: boolean;
    windowsFocus?: boolean;
    mediaStatus?: boolean;
    mediaControl?: boolean;
    screenCapture?: boolean;
    screenRead?: boolean;
  };
  maxApps?: number;
  includeNoDisplayApps?: boolean;
  allowedAppIds?: string[];
  allowedAppLaunchers?: Array<{
    id?: string;
    sha256?: string;
  }>;
  allowedMediaPlayers?: string[];
  allowedMediaActions?: MediaControlAction[];
  windows?: {
    enabled?: boolean;
    allowX11?: boolean;
    includeTitles?: boolean;
    allowedFocusClasses?: string[];
  };
  screenCapture?: {
    enabled?: boolean;
    outputDir?: string;
    timeoutMs?: number;
  };
  screenRead?: {
    enabled?: boolean;
    allowCapture?: boolean;
  };
};

export type LinuxDesktopHostOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  workspaceDir?: string;
  sysRoot?: string;
  osReleasePath?: string;
  dbusServiceDirs?: string[];
  xdgDataHome?: string;
  xdgDataDirs?: string[];
  homeDir?: string;
  runCommand?: CommandRunner;
  runPortalScreenshot?: PortalScreenshotRunner;
};

type DesktopEntry = {
  id: string;
  name: string;
  genericName?: string;
  comment?: string;
  categories: string[];
  terminal: boolean;
  noDisplay: boolean;
  hidden: boolean;
  launcherAvailable: boolean;
  launchAllowed: boolean;
  source: "user" | "system";
  launcherTrust: "trusted-system" | "fingerprint-required" | "fingerprint-match";
};

type UsbDevice = {
  id: string;
  busNumber?: string;
  deviceNumber?: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
  product?: string;
  speed?: string;
  deviceClass?: string;
  driver?: string;
  serialPresent: boolean;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

type CommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

type MediaControlAction = "play" | "pause" | "playPause" | "next" | "previous" | "stop";
type ScreenCaptureTarget = "screen" | "window" | "area" | "activeWindow";
type LinuxWindow = {
  id: string;
  desktop: number;
  pid?: number;
  geometry: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  wmClass: string;
  title?: string;
  titlePresent: boolean;
};

type PortalScreenshotRunner = (params: {
  target?: ScreenCaptureTarget;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}) => Promise<{ uri: string; response: number }>;

const ACTIONS = [
  "status",
  "apps.list",
  "apps.launch",
  "devices.usb",
  "windows.list",
  "windows.focus",
  "media.status",
  "media.control",
  "screen.capture",
  "screen.read",
] as const;

const MEDIA_CONTROL_ACTIONS = ["play", "pause", "playPause", "next", "previous", "stop"] as const;
const SCREEN_CAPTURE_TARGETS = ["screen", "window", "area", "activeWindow"] as const;
const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const execFileAsync = promisify(execFile);
const DEFAULT_SCREEN_CAPTURE_OUTPUT_DIR = "output/linux-desktop-captures";
const REDACTED = "[redacted]";
const DESKTOP_APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.desktop$/;
const MPRIS_PLAYER_ID_RE = /^(org\.mpris\.MediaPlayer2\.)?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const X11_WINDOW_ID_RE = /^0x[0-9a-fA-F]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_APP_ALLOWLIST_ENTRIES = 200;
const MAX_APP_LAUNCHER_ALLOWLIST_ENTRIES = 200;
const MAX_MEDIA_PLAYER_ALLOWLIST_ENTRIES = 100;
const MAX_WINDOW_CLASS_ALLOWLIST_ENTRIES = 200;
const SENSITIVE_ENV_NAME_RE =
  /(?:^|_)(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|authorization|bearer[_-]?token|oauth[_-]?token|token|password|secret|secret[_-]?access[_-]?key|credentials?|private[_-]?key)$/i;
const SENSITIVE_IDENTIFIER_SEGMENT_RE =
  /(?:^|[_.-])(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|authorization|bearer[_-]?token|oauth[_-]?token|token|password|secret|secret[_-]?access[_-]?key|credentials?|private[_-]?key)(?:$|[_.-])/i;
const PROVIDER_ENV_PREFIX_RE =
  /^(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|AZURE_OPENAI|AWS|BEDROCK|XAI|GROQ|MISTRAL|PERPLEXITY|ELEVENLABS|DEEPGRAM|CODEX|CHATGPT)(?:_|$)/i;
const DESKTOP_SUBPROCESS_ENV_NAME_RE =
  /^(?:PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z0-9_]+|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|DESKTOP_SESSION|GIO_USE_VFS|GIO_USE_VOLUME_MONITOR|GTK_USE_PORTAL|QT_QPA_PLATFORM|MOZ_ENABLE_WAYLAND|XDG_(?:RUNTIME_DIR|SESSION_TYPE|SESSION_DESKTOP|CURRENT_DESKTOP|DATA_HOME|DATA_DIRS|CONFIG_HOME|CONFIG_DIRS|CACHE_HOME|STATE_HOME|MENU_PREFIX|SEAT|VTNR))$/;
const OUTPUT_ARTIFACT_RE = /^output\/(?!.*(?:^|\/)\.\.)(?!$).+/;
const OUTPUT_ARTIFACT_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCREEN_CAPTURE_ARTIFACT_RE =
  /^linux-desktop-(screen|window|area|activeWindow|interactive)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-[1-9][0-9]{0,3})?\.png$/;
const MAX_DESKTOP_ENTRY_BYTES = 128 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SCREEN_CAPTURE_ARTIFACT_BYTES = 6 * 1024 * 1024;
const MAX_SCREEN_CAPTURE_MANIFEST_BYTES = 64 * 1024;
const SCREEN_CAPTURE_MANIFEST_KIND = "openclaw.linux_desktop.screen_capture";
const SCREEN_CAPTURE_CONSENT_MODE = "xdg-desktop-portal-interactive";
const TRUSTED_BACKEND_COMMAND_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;
const LINUX_DESKTOP_BACKEND_COMMANDS = new Set(["gio", "wmctrl", "busctl", "gdbus"]);
const WAYLAND_WINDOW_STRATEGY = "unsupported-generic-window-control";
const WAYLAND_WINDOW_REASON =
  "Wayland does not expose a safe generic public window inventory/focus API; use portal captures, browser automation, nodes, or owned-surface protocols instead.";
const LINUX_DESKTOP_PARAM_KEYS = new Set([
  "action",
  "includeHidden",
  "maxResults",
  "appId",
  "player",
  "windowId",
  "includeTitles",
  "mediaAction",
  "screenTarget",
  "artifactPath",
]);
const LINUX_DESKTOP_ACTION_PARAMS: Record<(typeof ACTIONS)[number], Set<string>> = {
  status: new Set(["action"]),
  "apps.list": new Set(["action", "includeHidden", "maxResults"]),
  "apps.launch": new Set(["action", "appId"]),
  "devices.usb": new Set(["action", "maxResults"]),
  "windows.list": new Set(["action", "includeTitles", "maxResults"]),
  "windows.focus": new Set(["action", "windowId"]),
  "media.status": new Set(["action", "maxResults"]),
  "media.control": new Set(["action", "player", "mediaAction"]),
  "screen.capture": new Set(["action", "screenTarget"]),
  "screen.read": new Set(["action", "artifactPath", "screenTarget"]),
};

const LinuxDesktopToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [...ACTIONS],
      description: "Linux desktop action.",
    },
    includeHidden: {
      type: "boolean",
      description: "apps.list: include NoDisplay/Hidden desktop entries.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: 1000,
      description: "apps.list/devices.usb/windows.list/media.status result cap.",
    },
    appId: {
      type: "string",
      pattern: DESKTOP_APP_ID_RE.source,
      description: "apps.launch: exact allowlisted XDG desktop entry id.",
    },
    player: {
      type: "string",
      pattern: MPRIS_PLAYER_ID_RE.source,
      description: "media.control: exact allowlisted MPRIS player id.",
    },
    windowId: {
      type: "string",
      pattern: X11_WINDOW_ID_RE.source,
      description: "windows.focus: exact X11 window id from windows.list.",
    },
    includeTitles: {
      type: "boolean",
      description: "windows.list: include visible window titles when configured.",
    },
    mediaAction: {
      type: "string",
      enum: [...MEDIA_CONTROL_ACTIONS],
      description: "media.control: allowlisted MPRIS transport action.",
    },
    screenTarget: {
      type: "string",
      enum: [...SCREEN_CAPTURE_TARGETS],
      description: "screen.capture: portal screenshot target.",
    },
    artifactPath: {
      type: "string",
      pattern: OUTPUT_ARTIFACT_RE.source,
      description: "screen.read: existing screen.capture artifact path under output/.",
    },
  },
} as const;

function screenImageResult(params: {
  path: string;
  base64: string;
  artifact: {
    path: string;
    bytes: number;
    dimensions: { width: number; height: number };
  };
  captured: boolean;
  capture: unknown;
}) {
  return {
    content: [
      { type: "text" as const, text: `SCREEN:${params.path}` },
      {
        type: "image" as const,
        data: params.base64,
        mimeType: "image/png",
      },
    ],
    details: {
      path: params.path,
      ok: true,
      tool: "linux_desktop",
      action: "screen.read",
      artifact: params.artifact,
      captured: params.captured,
      capture: params.capture,
      media: {
        mediaUrl: params.path,
      },
      note: "Image is attached to this tool result for the Gateway agent/model to inspect; linux_desktop does not perform OCR or provider calls.",
    },
  };
}

function pluginConfig(api: OpenClawPluginApi): LinuxDesktopPluginConfig {
  return (api.pluginConfig ?? {}) as LinuxDesktopPluginConfig;
}

function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function actionGateEnabled(
  config: LinuxDesktopPluginConfig | undefined,
  key: keyof NonNullable<LinuxDesktopPluginConfig["actions"]>,
) {
  const actions = config?.actions as unknown;
  const defaultEnabled = key === "status" || key === "appsList" || key === "devicesUsb";
  if (actions === undefined) {
    return defaultEnabled;
  }
  if (!isPlainConfigObject(actions)) {
    return false;
  }
  const value = actions[key];
  if (value === undefined) {
    return defaultEnabled;
  }
  return value === true;
}

function ensureActionAllowed(
  config: LinuxDesktopPluginConfig,
  key: keyof NonNullable<LinuxDesktopPluginConfig["actions"]>,
  action: (typeof ACTIONS)[number],
) {
  if (!actionGateEnabled(config, key)) {
    fail(
      "LINUX_DESKTOP_ACTION_DISABLED",
      action,
      `linux_desktop action disabled by plugin config: ${key}`,
      { configKey: key },
    );
  }
}

class LinuxDesktopToolError extends Error {
  readonly code: string;
  readonly action: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    action: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LinuxDesktopToolError";
    this.code = code;
    this.action = action;
    this.details = sanitizeDiagnosticDetails(details);
  }
}

function fail(
  code: string,
  action: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new LinuxDesktopToolError(code, action, message, details);
}

function isLinuxDesktopAction(value: string): value is (typeof ACTIONS)[number] {
  return (ACTIONS as readonly string[]).includes(value);
}

function invalidParameter(
  action: string,
  parameter: string,
  reason: string,
  value?: unknown,
): never {
  fail(
    "LINUX_DESKTOP_INVALID_PARAMETER",
    isLinuxDesktopAction(action) ? action : "unknown",
    "invalid linux_desktop parameter",
    {
      parameter,
      reason,
      ...(value === undefined ? {} : { value }),
    },
  );
}

function assertKnownLinuxDesktopParams(params: Record<string, unknown>, action: string) {
  const actionParams = isLinuxDesktopAction(action)
    ? LINUX_DESKTOP_ACTION_PARAMS[action]
    : undefined;
  for (const key of Object.keys(params)) {
    if (!LINUX_DESKTOP_PARAM_KEYS.has(key)) {
      fail(
        "LINUX_DESKTOP_UNKNOWN_PARAMETER",
        isLinuxDesktopAction(action) ? action : "unknown",
        "unknown linux_desktop parameter",
        { parameter: key },
      );
    }
    if (actionParams && !actionParams.has(key)) {
      fail(
        "LINUX_DESKTOP_UNSUPPORTED_PARAMETER",
        action,
        "linux_desktop parameter is not supported for this action",
        { parameter: key },
      );
    }
  }
  if ("includeHidden" in params && typeof params.includeHidden !== "boolean") {
    invalidParameter(action, "includeHidden", "must be boolean", params.includeHidden);
  }
  if ("includeTitles" in params && typeof params.includeTitles !== "boolean") {
    invalidParameter(action, "includeTitles", "must be boolean", params.includeTitles);
  }
  if (
    "maxResults" in params &&
    !(
      typeof params.maxResults === "number" &&
      Number.isFinite(params.maxResults) &&
      Number.isInteger(params.maxResults) &&
      params.maxResults >= 1 &&
      params.maxResults <= 1000
    )
  ) {
    invalidParameter(action, "maxResults", "must be an integer from 1 to 1000", params.maxResults);
  }
  if (
    "appId" in params &&
    !(typeof params.appId === "string" && DESKTOP_APP_ID_RE.test(params.appId))
  ) {
    invalidParameter(action, "appId", "must be a valid .desktop id", params.appId);
  }
  if (
    "player" in params &&
    !(typeof params.player === "string" && MPRIS_PLAYER_ID_RE.test(params.player))
  ) {
    invalidParameter(action, "player", "must be a valid MPRIS player id", params.player);
  }
  if (
    "windowId" in params &&
    !(typeof params.windowId === "string" && X11_WINDOW_ID_RE.test(params.windowId))
  ) {
    invalidParameter(action, "windowId", "must be a valid X11 window id", params.windowId);
  }
  if (
    "mediaAction" in params &&
    !MEDIA_CONTROL_ACTIONS.includes(params.mediaAction as MediaControlAction)
  ) {
    invalidParameter(action, "mediaAction", "must be a supported media action", params.mediaAction);
  }
  if (
    "screenTarget" in params &&
    !SCREEN_CAPTURE_TARGETS.includes(params.screenTarget as ScreenCaptureTarget)
  ) {
    invalidParameter(
      action,
      "screenTarget",
      "must be a supported screen capture target",
      params.screenTarget,
    );
  }
  if (
    "artifactPath" in params &&
    !(typeof params.artifactPath === "string" && OUTPUT_ARTIFACT_RE.test(params.artifactPath))
  ) {
    invalidParameter(
      action,
      "artifactPath",
      "must be a relative output/ artifact path",
      params.artifactPath,
    );
  }
}

function readLinuxDesktopParams(params: unknown) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    fail(
      "LINUX_DESKTOP_INVALID_PARAMETERS",
      "unknown",
      "linux_desktop parameters must be a plain object",
      {
        parameterType: Array.isArray(params) ? "array" : typeof params,
      },
    );
  }
  const prototype = Object.getPrototypeOf(params);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(
      "LINUX_DESKTOP_INVALID_PARAMETERS",
      "unknown",
      "linux_desktop parameters must be a plain object",
      { parameterType: "object" },
    );
  }
  return params as Record<string, unknown>;
}

function readLinuxDesktopAction(params: unknown) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return "";
  }
  const action = (params as Record<string, unknown>).action;
  return typeof action === "string" ? action : "";
}

function optionalNumberParam(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function isNonEmptyString(value: string | undefined): value is string {
  return Boolean(value);
}

function sanitizeDiagnosticText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|sess_[A-Za-z0-9_-]{8,}|ek_[A-Za-z0-9_-]{8,})\b/g, REDACTED)
    .replace(
      /\b([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|authorization|bearer[_-]?token|oauth[_-]?token|token|password|secret|secret[_-]?access[_-]?key|credentials?|private[_-]?key))\s*[:=]\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^,\s;'"`)]+)/gi,
      `$1=${REDACTED}`,
    )
    .replace(
      /file:\/\/\/(?:home|Users|tmp|var\/tmp|run\/user|mnt|media)\/[^\s'"`)]+/g,
      `file://${REDACTED}`,
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\/(?:home|Users|tmp|var\/tmp|run\/user|mnt|media)\/[^\s'"`)]+/g, REDACTED)
    .replace(/[A-Za-z]:\\Users\\[^\s'"`)]+/g, REDACTED)
    .slice(0, 600);
}

function sanitizeDiagnosticDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeDiagnosticValue(details) as Record<string, unknown>;
}

function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return sanitizeDiagnosticText(value);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return depth >= 3
      ? "[array]"
      : value.slice(0, 20).map((entry) => sanitizeDiagnosticValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 3) {
      return "[object]";
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, entry]) => [
          sanitizeDiagnosticText(key),
          sanitizeDiagnosticValue(entry, depth + 1),
        ]),
    );
  }
  return sanitizeDiagnosticText(value);
}

function clampLimit(value: unknown, fallback: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function runtimePolicyLimit(value: unknown, fallback: number, max: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    return fallback;
  }
  return value;
}

function resolvedPathStaysInside(root: string, candidate: string) {
  try {
    const resolvedRoot = fs.realpathSync(root);
    const resolvedCandidate = fs.realpathSync(candidate);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return (
      relative === "" ||
      (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative))
    );
  } catch {
    return false;
  }
}

function readTextIfExists(filePath: string): string | undefined {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readLinkTargetBase(filePath: string): string | undefined {
  try {
    return path.basename(fs.readlinkSync(filePath));
  } catch {
    return undefined;
  }
}

function readSanitizedTextIfExists(filePath: string): string | undefined {
  const value = readTextIfExists(filePath);
  if (!value) {
    return undefined;
  }
  const sanitized = sanitizeDiagnosticText(value).trim();
  return sanitized || undefined;
}

function readSanitizedLinkTargetBase(filePath: string): string | undefined {
  const value = readLinkTargetBase(filePath);
  if (!value) {
    return undefined;
  }
  const sanitized = sanitizeDiagnosticText(value).trim();
  return sanitized || undefined;
}

function readUsbHexText(filePath: string, digits: number) {
  const value = readTextIfExists(filePath);
  if (!value) {
    return undefined;
  }
  const pattern = new RegExp(`^[0-9a-fA-F]{${digits}}$`);
  return pattern.test(value) ? value.toLowerCase() : undefined;
}

function readUsbDecimalText(filePath: string) {
  const value = readTextIfExists(filePath);
  return value && /^[0-9]+$/.test(value) ? value : undefined;
}

function readUsbSpeedText(filePath: string) {
  const value = readTextIfExists(filePath);
  return value && /^[0-9]+(?:\.[0-9]+)?$/.test(value) ? value : undefined;
}

function usbDeviceId(params: { busNumber?: string; deviceNumber?: string; dir: string }) {
  if (params.busNumber && params.deviceNumber) {
    return `${params.busNumber}-${params.deviceNumber}`;
  }
  const basename = path.basename(params.dir);
  if (
    /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(basename) &&
    !(/[_.:-]/.test(basename) && SENSITIVE_IDENTIFIER_SEGMENT_RE.test(basename))
  ) {
    return basename;
  }
  return "usb-device";
}

function buildSubprocessEnv(env: NodeJS.ProcessEnv) {
  const safeEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      !DESKTOP_SUBPROCESS_ENV_NAME_RE.test(key) ||
      SENSITIVE_ENV_NAME_RE.test(key) ||
      PROVIDER_ENV_PREFIX_RE.test(key)
    ) {
      continue;
    }
    safeEnv[key] = value;
  }
  return safeEnv;
}

function trustedBackendCommandError(command: string, reason: string) {
  return new Error(`linux_desktop backend command unavailable: ${command} (${reason})`);
}

function isTrustedBackendCommand(command: string) {
  return LINUX_DESKTOP_BACKEND_COMMANDS.has(command) && !command.includes(path.sep);
}

function trustedCommandDir(filePath: string) {
  const dir = path.dirname(filePath);
  return TRUSTED_BACKEND_COMMAND_DIRS.some((trustedDir) => {
    try {
      return dir === fs.realpathSync(trustedDir);
    } catch {
      return dir === trustedDir;
    }
  });
}

function isOwnerOnlyWritable(mode: number) {
  return (mode & 0o022) === 0;
}

function resolveTrustedBackendCommand(command: string) {
  if (!isTrustedBackendCommand(command)) {
    throw trustedBackendCommandError(command, "unsupported helper");
  }
  for (const dir of TRUSTED_BACKEND_COMMAND_DIRS) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const resolved = fs.realpathSync(candidate);
      const fileStat = fs.statSync(resolved);
      const dirStat = fs.statSync(path.dirname(resolved));
      if (
        fileStat.isFile() &&
        trustedCommandDir(resolved) &&
        fileStat.uid === 0 &&
        dirStat.uid === 0 &&
        isOwnerOnlyWritable(fileStat.mode) &&
        isOwnerOnlyWritable(dirStat.mode)
      ) {
        return resolved;
      }
    } catch {
      continue;
    }
  }
  throw trustedBackendCommandError(command, "trusted executable not found");
}

async function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const resolvedCommand = resolveTrustedBackendCommand(command);
  const result = await execFileAsync(resolvedCommand, args, {
    encoding: "utf8",
    env: buildSubprocessEnv(options.env ?? process.env),
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs ?? 5000,
    windowsHide: true,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function createPortalHandleToken() {
  return `openclaw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function screenCaptureTargetValue(target: ScreenCaptureTarget | undefined) {
  switch (target) {
    case "screen":
      return 1;
    case "window":
      return 2;
    case "area":
      return 4;
    case "activeWindow":
      return 8;
    case undefined:
      return undefined;
  }
  return undefined;
}

function portalScreenshotOptions(token: string, target: ScreenCaptureTarget | undefined) {
  const entries = [`'handle_token': <'${token}'>`, "'interactive': <true>"];
  const targetValue = screenCaptureTargetValue(target);
  if (targetValue) {
    entries.push(`'target': <uint32 ${targetValue}>`);
  }
  return `{${entries.join(", ")}}`;
}

function parsePortalScreenshotResponse(buffer: string, token: string) {
  if (!buffer.includes(token) || !buffer.includes("org.freedesktop.portal.Request.Response")) {
    return undefined;
  }
  const responseMatch = buffer.match(/Response\s+\(uint32\s+(\d+)/);
  if (!responseMatch) {
    return undefined;
  }
  const response = Number(responseMatch[1]);
  const uri = buffer.match(/'uri':\s*<['"]([^'"]+)['"]>/)?.[1];
  return { response, uri };
}

async function defaultRunPortalScreenshot(params: {
  target?: ScreenCaptureTarget;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}) {
  const gdbus = resolveTrustedBackendCommand("gdbus");
  const token = createPortalHandleToken();
  const timeoutMs = params.timeoutMs ?? 120000;

  return await new Promise<{ uri: string; response: number }>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const monitor = spawn(
      gdbus,
      ["monitor", "--session", "--dest", "org.freedesktop.portal.Desktop"],
      {
        env: buildSubprocessEnv(params.env ?? process.env),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const cleanup = () => {
      monitor.kill("SIGTERM");
    };
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      cleanup();
      fn();
    };
    const timeout = setTimeout(() => {
      settle(() => reject(new Error("timed out waiting for portal screenshot response")));
    }, timeoutMs);
    monitor.on("error", (err) => {
      settle(() => reject(err));
    });
    const inspectBuffer = () => {
      const parsed = parsePortalScreenshotResponse(buffer, token);
      if (!parsed) {
        return;
      }
      if (parsed.response !== 0) {
        settle(() => reject(new Error(`portal screenshot response ${parsed.response}`)));
        return;
      }
      const uri = parsed.uri;
      if (!uri) {
        settle(() => reject(new Error("portal screenshot response missing uri")));
        return;
      }
      settle(() => resolve({ uri, response: parsed.response }));
    };
    monitor.stdout?.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      inspectBuffer();
    });
    monitor.stderr?.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
    });

    setTimeout(() => {
      if (settled) {
        return;
      }
      execFile(
        gdbus,
        [
          "call",
          "--session",
          "--dest",
          "org.freedesktop.portal.Desktop",
          "--object-path",
          "/org/freedesktop/portal/desktop",
          "--method",
          "org.freedesktop.portal.Screenshot.Screenshot",
          "",
          portalScreenshotOptions(token, params.target),
        ],
        {
          encoding: "utf8",
          env: buildSubprocessEnv(params.env ?? process.env),
          timeout: 10000,
          windowsHide: true,
        },
        (err) => {
          if (err) {
            settle(() => reject(err));
          }
        },
      );
    }, 50);
  });
}

function parseOsRelease(raw: string | undefined) {
  const entries = new Map<string, string>();
  for (const line of raw?.split(/\r?\n/) ?? []) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1] ?? "";
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const sanitized = sanitizeStatusText(value.replaceAll('\\"', '"'));
    if (sanitized) {
      entries.set(key, sanitized);
    }
  }
  return {
    id: entries.get("ID"),
    name: entries.get("NAME"),
    versionId: entries.get("VERSION_ID"),
    prettyName: entries.get("PRETTY_NAME"),
  };
}

function sanitizeStatusText(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = sanitizeDiagnosticText(trimmed).trim();
  return sanitized || undefined;
}

function defaultXdgDataDirs(env: NodeJS.ProcessEnv) {
  const raw = env.XDG_DATA_DIRS?.trim();
  if (!raw) {
    return ["/usr/local/share", "/usr/share"];
  }
  return raw
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function commandAvailable(command: string, env: NodeJS.ProcessEnv) {
  void env;
  try {
    resolveTrustedBackendCommand(command);
    return true;
  } catch {
    return false;
  }
}

function usingDefaultRunCommand(options: LinuxDesktopHostOptions | undefined) {
  return options?.runCommand === undefined;
}

function usingDefaultPortalScreenshot(options: LinuxDesktopHostOptions | undefined) {
  return options?.runPortalScreenshot === undefined;
}

function ensureBackendCommandAvailable(params: {
  command: string;
  action: string;
  host: ReturnType<typeof resolveHostOptions>;
  hostOptions?: LinuxDesktopHostOptions;
}) {
  if (!usingDefaultRunCommand(params.hostOptions)) {
    return;
  }
  if (commandAvailable(params.command, params.host.env)) {
    return;
  }
  fail(
    "LINUX_DESKTOP_BACKEND_UNAVAILABLE",
    params.action,
    `linux_desktop backend command unavailable: ${params.command}`,
    { backend: params.command },
  );
}

function backendCommandAvailableForAction(params: {
  command: string;
  host: ReturnType<typeof resolveHostOptions>;
  hostOptions?: LinuxDesktopHostOptions;
}) {
  return (
    !usingDefaultRunCommand(params.hostOptions) || commandAvailable(params.command, params.host.env)
  );
}

function resolveHostOptions(options: LinuxDesktopHostOptions = {}) {
  const env = options.env ?? process.env;
  const subprocessEnv = buildSubprocessEnv(env);
  const homeDir = options.homeDir ?? os.homedir();
  const xdgDataHome =
    options.xdgDataHome ?? env.XDG_DATA_HOME ?? path.join(homeDir, ".local/share");
  return {
    env,
    subprocessEnv,
    platform: options.platform ?? process.platform,
    sysRoot: options.sysRoot ?? "/sys",
    osReleasePath: options.osReleasePath ?? "/etc/os-release",
    dbusServiceDirs: options.dbusServiceDirs ?? [
      path.join(homeDir, ".local/share/dbus-1/services"),
      "/usr/local/share/dbus-1/services",
      "/usr/share/dbus-1/services",
    ],
    xdgDataHome,
    xdgDataDirs: options.xdgDataDirs ?? defaultXdgDataDirs(env),
    runCommand: options.runCommand ?? defaultRunCommand,
    runPortalScreenshot: options.runPortalScreenshot ?? defaultRunPortalScreenshot,
    workspaceDir: path.resolve(options.workspaceDir ?? process.cwd()),
  };
}

function desktopPortalAvailable(serviceDirs: string[]) {
  return serviceDirs.some((dir) =>
    fs.existsSync(path.join(dir, "org.freedesktop.portal.Desktop.service")),
  );
}

export function getLinuxDesktopStatus(
  options: LinuxDesktopHostOptions & { config?: LinuxDesktopPluginConfig } = {},
) {
  const { config, ...hostOptions } = options;
  const host = resolveHostOptions(hostOptions);
  const distro = parseOsRelease(readTextIfExists(host.osReleasePath));
  const applicationsDirs = [
    path.join(host.xdgDataHome, "applications"),
    ...host.xdgDataDirs.map((dir) => path.join(dir, "applications")),
  ];
  const backends = {
    gio: commandAvailable("gio", host.env),
    wmctrl: commandAvailable("wmctrl", host.env),
    busctl: commandAvailable("busctl", host.env),
    gdbus: commandAvailable("gdbus", host.env),
  };
  const hostCapabilities = {
    status: true,
    appsList: host.platform === "linux",
    devicesUsb: fs.existsSync(path.join(host.sysRoot, "bus/usb/devices")),
    appsLaunch: host.platform === "linux" && backends.gio,
    windowsList: host.platform === "linux" && isX11Session(host) && backends.wmctrl,
    windowsFocus: host.platform === "linux" && isX11Session(host) && backends.wmctrl,
    mediaStatus:
      host.platform === "linux" && Boolean(host.env.DBUS_SESSION_BUS_ADDRESS) && backends.busctl,
    mediaControl:
      host.platform === "linux" && Boolean(host.env.DBUS_SESSION_BUS_ADDRESS) && backends.busctl,
    screenCapture:
      host.platform === "linux" &&
      Boolean(host.env.DBUS_SESSION_BUS_ADDRESS) &&
      desktopPortalAvailable(host.dbusServiceDirs) &&
      backends.gdbus,
    screenRead: host.platform === "linux",
  };
  const allowedAppCount = normalizedAppIdAllowlist(config?.allowedAppIds).size;
  const allowedAppLauncherCount = normalizedAppLauncherAllowlist(config?.allowedAppLaunchers).size;
  const allowedMediaPlayerCount = normalizedMediaPlayerAllowlist(config?.allowedMediaPlayers).size;
  const allowedMediaActionCount = normalizedMediaActionAllowlist(config?.allowedMediaActions).size;
  const allowedWindowFocusClassCount = normalizedWindowClassAllowlist(
    config?.windows?.allowedFocusClasses,
  ).size;
  const enabledCapabilities = {
    status: hostCapabilities.status && actionGateEnabled(config, "status"),
    appsList: hostCapabilities.appsList && actionGateEnabled(config, "appsList"),
    devicesUsb: hostCapabilities.devicesUsb && actionGateEnabled(config, "devicesUsb"),
    appsLaunch:
      hostCapabilities.appsLaunch && actionGateEnabled(config, "appsLaunch") && allowedAppCount > 0,
    windowsList:
      hostCapabilities.windowsList &&
      actionGateEnabled(config, "windowsList") &&
      config?.windows?.enabled === true &&
      config?.windows?.allowX11 === true,
    windowsFocus:
      hostCapabilities.windowsFocus &&
      actionGateEnabled(config, "windowsFocus") &&
      config?.windows?.enabled === true &&
      config.windows.allowX11 === true &&
      allowedWindowFocusClassCount > 0,
    mediaStatus: hostCapabilities.mediaStatus && actionGateEnabled(config, "mediaStatus"),
    mediaControl:
      hostCapabilities.mediaControl &&
      actionGateEnabled(config, "mediaControl") &&
      allowedMediaPlayerCount > 0 &&
      allowedMediaActionCount > 0,
    screenCapture:
      hostCapabilities.screenCapture &&
      actionGateEnabled(config, "screenCapture") &&
      config?.screenCapture?.enabled === true,
    screenRead:
      hostCapabilities.screenRead &&
      actionGateEnabled(config, "screenRead") &&
      config?.screenRead?.enabled === true,
  };
  return {
    ok: true,
    tool: "linux_desktop",
    action: "status",
    platform: host.platform,
    supported: host.platform === "linux",
    host: {
      distro,
      arch: os.arch(),
      release: os.release(),
      sessionType: sanitizeStatusText(host.env.XDG_SESSION_TYPE),
      desktop: sanitizeStatusText(host.env.XDG_CURRENT_DESKTOP ?? host.env.DESKTOP_SESSION),
      wayland: Boolean(host.env.WAYLAND_DISPLAY),
      x11: Boolean(host.env.DISPLAY),
    },
    capabilities: hostCapabilities,
    enabledCapabilities,
    policy: {
      allowedAppCount,
      allowedAppLauncherCount,
      allowedMediaPlayerCount,
      allowedMediaActionCount,
      allowedWindowFocusClassCount,
      screenCaptureEnabled: config?.screenCapture?.enabled === true,
      screenReadEnabled: config?.screenRead?.enabled === true,
      screenReadAllowCapture: config?.screenRead?.allowCapture === true,
      x11WindowsEnabled: config?.windows?.enabled === true,
      x11WindowsAllowX11: config?.windows?.allowX11 === true,
    },
    portals: {
      desktopPortalAvailable: desktopPortalAvailable(host.dbusServiceDirs),
    },
    windowBackends: linuxWindowBackendStatus({ host, config, backends }),
    buses: {
      sessionBusAvailable: Boolean(host.env.DBUS_SESSION_BUS_ADDRESS),
    },
    backends,
    dataSources: {
      applicationsDirs: applicationsDirs.map((dir) => ({
        scope: dir.startsWith(host.xdgDataHome) ? "user" : "system",
        available: fs.existsSync(dir),
      })),
      usbSysfsAvailable: fs.existsSync(path.join(host.sysRoot, "bus/usb/devices")),
    },
  };
}

function parseDesktopEntry(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  let inDesktopEntry = false;
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inDesktopEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inDesktopEntry) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (key.includes("[")) {
      continue;
    }
    values[key] = line.slice(eq + 1).trim();
  }
  return values;
}

function toBool(value: string | undefined) {
  return value?.toLowerCase() === "true";
}

function parseDesktopFile(params: {
  filePath: string;
  appDir: string;
  source: "user" | "system";
}): DesktopEntry | null {
  const stat = fs.statSync(params.filePath);
  if (stat.size > MAX_DESKTOP_ENTRY_BYTES) {
    throw new Error("desktop entry is too large");
  }
  const values = parseDesktopEntry(fs.readFileSync(params.filePath, "utf8"));
  if ((values.Type ?? "Application") !== "Application") {
    return null;
  }
  const name = sanitizeDesktopEntryText(values.Name);
  if (!name) {
    return null;
  }
  const id = path.relative(params.appDir, params.filePath).replaceAll(path.sep, "-");
  if (!isValidDesktopAppId(id)) {
    return null;
  }
  return {
    id,
    name,
    genericName: sanitizeDesktopEntryText(values.GenericName),
    comment: sanitizeDesktopEntryText(values.Comment),
    categories: (values.Categories ?? "")
      .split(";")
      .map((entry) => sanitizeDesktopEntryText(entry))
      .filter(isNonEmptyString),
    terminal: toBool(values.Terminal),
    noDisplay: toBool(values.NoDisplay),
    hidden: toBool(values.Hidden),
    launcherAvailable: Boolean(values.Exec?.trim()) || toBool(values.DBusActivatable),
    launchAllowed: false,
    source: params.source,
    launcherTrust: "fingerprint-required",
  };
}

function sanitizeDesktopEntryText(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = sanitizeDiagnosticText(trimmed).trim();
  return sanitized || undefined;
}

function walkDesktopFiles(dir: string, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDesktopFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".desktop")) {
      out.push(fullPath);
    }
  }
}

export function listLinuxDesktopApps(
  params: {
    includeHidden?: boolean;
    maxResults?: number;
    pluginMaxApps?: number;
    pluginIncludeHidden?: boolean;
    allowedAppIds?: string[];
    allowedAppLaunchers?: LinuxDesktopPluginConfig["allowedAppLaunchers"];
    host?: LinuxDesktopHostOptions;
  } = {},
) {
  const host = resolveHostOptions(params.host);
  if (host.platform !== "linux") {
    return {
      ok: true,
      tool: "linux_desktop",
      action: "apps.list",
      available: false,
      reason: "unsupported platform",
      count: 0,
      total: 0,
      truncated: false,
      apps: [],
      errorCount: 0,
      errorsTruncated: false,
      errors: [],
    };
  }
  const includeHidden = params.pluginIncludeHidden === true && params.includeHidden !== false;
  const configuredMax = runtimePolicyLimit(params.pluginMaxApps, 200, 1000);
  const maxResults = Math.min(clampLimit(params.maxResults, configuredMax, 1000), configuredMax);
  const allowedAppIds = normalizedAppIdAllowlist(params.allowedAppIds);
  const allowedAppLaunchers = normalizedAppLauncherAllowlist(params.allowedAppLaunchers);
  const dirs = [
    { dir: path.join(host.xdgDataHome, "applications"), source: "user" as const },
    ...host.xdgDataDirs.map((dir) => ({
      dir: path.join(dir, "applications"),
      source: "system" as const,
    })),
  ];
  const seen = new Set<string>();
  const apps: DesktopEntry[] = [];
  const errors: Array<{ scope: string; reason: string }> = [];

  for (const { dir, source } of dirs) {
    const files: string[] = [];
    walkDesktopFiles(dir, files);
    for (const filePath of files) {
      try {
        const app = parseDesktopFile({ filePath, appDir: dir, source });
        if (!app || seen.has(app.id)) {
          continue;
        }
        seen.add(app.id);
        if (!includeHidden && (app.hidden || app.noDisplay)) {
          continue;
        }
        const launcherTrust = appLauncherTrust({
          app: { ...app, filePath, appDir: dir },
          allowedLaunchers: allowedAppLaunchers,
        });
        apps.push({
          ...app,
          launcherTrust,
          launchAllowed:
            allowedAppIds.has(app.id) &&
            app.launcherAvailable &&
            !app.terminal &&
            !app.hidden &&
            !app.noDisplay &&
            (launcherTrust === "trusted-system" || launcherTrust === "fingerprint-match"),
        });
      } catch (err) {
        errors.push({ scope: source, reason: sanitizeDiagnosticText(err) });
      }
    }
  }

  apps.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    ok: true,
    tool: "linux_desktop",
    action: "apps.list",
    count: Math.min(apps.length, maxResults),
    total: apps.length,
    truncated: apps.length > maxResults,
    apps: apps.slice(0, maxResults),
    errorCount: errors.length,
    errorsTruncated: errors.length > maxResults,
    errors: errors.slice(0, maxResults),
  };
}

function isValidDesktopAppId(appId: string) {
  if (!DESKTOP_APP_ID_RE.test(appId)) {
    return false;
  }
  const baseId = appId.slice(0, -".desktop".length);
  return !/[_.-]/.test(baseId) || !SENSITIVE_IDENTIFIER_SEGMENT_RE.test(baseId);
}

function normalizedAppLauncherAllowlist(values: unknown) {
  const allowlist = new Map<string, Set<string>>();
  if (!Array.isArray(values)) {
    return allowlist;
  }
  for (const value of values) {
    if (allowlist.size >= MAX_APP_LAUNCHER_ALLOWLIST_ENTRIES || !isPlainConfigObject(value)) {
      continue;
    }
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const sha256 = typeof value.sha256 === "string" ? value.sha256.trim().toLowerCase() : "";
    if (!isValidDesktopAppId(id) || !SHA256_RE.test(sha256)) {
      continue;
    }
    const hashes = allowlist.get(id) ?? new Set<string>();
    hashes.add(sha256);
    allowlist.set(id, hashes);
  }
  return allowlist;
}

function fileSha256(filePath: string) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function trustedRootOwnedRegularPath(filePath: string) {
  try {
    const lstat = fs.lstatSync(filePath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return false;
    }
    const resolved = fs.realpathSync(filePath);
    const stat = fs.statSync(resolved);
    return stat.isFile() && stat.uid === 0 && isOwnerOnlyWritable(stat.mode);
  } catch {
    return false;
  }
}

function trustedRootOwnedDirectoryPath(dirPath: string) {
  try {
    const lstat = fs.lstatSync(dirPath);
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
      return false;
    }
    const resolved = fs.realpathSync(dirPath);
    const stat = fs.statSync(resolved);
    return stat.isDirectory() && stat.uid === 0 && isOwnerOnlyWritable(stat.mode);
  } catch {
    return false;
  }
}

function trustedSystemDesktopEntry(filePath: string, appDir: string) {
  if (!resolvedPathStaysInside(appDir, filePath)) {
    return false;
  }
  const normalizedAppDir = path.resolve(appDir);
  if (
    normalizedAppDir !== "/usr/share/applications" &&
    normalizedAppDir !== "/usr/local/share/applications"
  ) {
    return false;
  }
  return trustedRootOwnedDirectoryPath(appDir) && trustedRootOwnedRegularPath(filePath);
}

function appLauncherTrust(params: {
  app: DesktopEntry & { filePath: string; appDir: string };
  allowedLaunchers: Map<string, Set<string>>;
}) {
  if (
    params.app.source === "system" &&
    trustedSystemDesktopEntry(params.app.filePath, params.app.appDir)
  ) {
    return "trusted-system" as const;
  }
  const allowedHashes = params.allowedLaunchers.get(params.app.id);
  if (!allowedHashes || allowedHashes.size === 0) {
    return "fingerprint-required" as const;
  }
  try {
    return allowedHashes.has(fileSha256(params.app.filePath))
      ? ("fingerprint-match" as const)
      : ("fingerprint-required" as const);
  } catch {
    return "fingerprint-required" as const;
  }
}

function normalizedAppIdAllowlist(values: unknown) {
  const allowlist = new Set<string>();
  if (!Array.isArray(values)) {
    return allowlist;
  }
  for (const value of values) {
    if (allowlist.size >= MAX_APP_ALLOWLIST_ENTRIES || typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (isValidDesktopAppId(trimmed)) {
      allowlist.add(trimmed);
    }
  }
  return allowlist;
}

function normalizedWindowClassAllowlist(values: unknown) {
  const allowlist = new Set<string>();
  if (!Array.isArray(values)) {
    return allowlist;
  }
  for (const value of values) {
    if (allowlist.size >= MAX_WINDOW_CLASS_ALLOWLIST_ENTRIES || typeof value !== "string") {
      continue;
    }
    const windowClass = normalizeWindowClass(value, { allowRedacted: false });
    if (windowClass) {
      allowlist.add(windowClass);
    }
  }
  return allowlist;
}

function normalizedMediaPlayerAllowlist(values: unknown) {
  const allowlist = new Set<string>();
  if (!Array.isArray(values)) {
    return allowlist;
  }
  for (const value of values) {
    if (allowlist.size >= MAX_MEDIA_PLAYER_ALLOWLIST_ENTRIES || typeof value !== "string") {
      continue;
    }
    const player = normalizePlayerId(value);
    if (player) {
      allowlist.add(player);
    }
  }
  return allowlist;
}

function normalizedMediaActionAllowlist(values: unknown) {
  if (!Array.isArray(values)) {
    return new Set<MediaControlAction>();
  }
  return new Set(
    values.filter((value): value is MediaControlAction =>
      MEDIA_CONTROL_ACTIONS.includes(value as MediaControlAction),
    ),
  );
}

function isWaylandSession(host: ReturnType<typeof resolveHostOptions>) {
  return (
    host.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" ||
    (Boolean(host.env.WAYLAND_DISPLAY) && host.env.XDG_SESSION_TYPE?.toLowerCase() !== "x11")
  );
}

function isX11Session(host: ReturnType<typeof resolveHostOptions>) {
  return Boolean(host.env.DISPLAY) && !isWaylandSession(host);
}

function linuxWindowBackendStatus(params: {
  host: ReturnType<typeof resolveHostOptions>;
  config?: LinuxDesktopPluginConfig;
  backends: { wmctrl: boolean };
}) {
  const x11Available = isX11Session(params.host) && params.backends.wmctrl;
  const x11Enabled =
    x11Available &&
    actionGateEnabled(params.config, "windowsList") &&
    params.config?.windows?.enabled === true &&
    params.config?.windows?.allowX11 === true;
  return {
    x11: {
      available: x11Available,
      enabled: x11Enabled,
      helper: "wmctrl",
      reason: x11Available ? undefined : "x11 display or wmctrl unavailable",
    },
    wayland: {
      available: false,
      enabled: false,
      strategy: WAYLAND_WINDOW_STRATEGY,
      reason: WAYLAND_WINDOW_REASON,
      safeAlternatives: ["screen.capture", "screen.read", "browser", "nodes", "owned-surfaces"],
    },
  };
}

function sanitizeWindowText(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = sanitizeDiagnosticText(trimmed).trim();
  return sanitized || undefined;
}

function normalizeWindowClass(
  value: string | undefined,
  options: { allowRedacted: boolean } = { allowRedacted: true },
) {
  const trimmed = value?.trim();
  if (trimmed && /[_.-]/.test(trimmed) && SENSITIVE_IDENTIFIER_SEGMENT_RE.test(trimmed)) {
    return undefined;
  }
  const sanitized = sanitizeWindowText(value);
  if (!sanitized) {
    return undefined;
  }
  if (options.allowRedacted && sanitized.includes(REDACTED)) {
    return sanitized;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(sanitized)) {
    return undefined;
  }
  return sanitized;
}

function parseWmctrlWindows(stdout: string, includeTitles: boolean): LinuxWindow[] {
  const windows: LinuxWindow[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 8) {
      continue;
    }
    const [id, desktopRaw, pidRaw, xRaw, yRaw, widthRaw, heightRaw, wmClass] = parts;
    if (!id || !/^0x[0-9a-fA-F]+$/.test(id) || !wmClass) {
      continue;
    }
    const safeWmClass = normalizeWindowClass(wmClass);
    if (!safeWmClass) {
      continue;
    }
    const desktop = Number(desktopRaw);
    const pid = Number(pidRaw);
    const x = Number(xRaw);
    const y = Number(yRaw);
    const width = Number(widthRaw);
    const height = Number(heightRaw);
    if (
      !Number.isFinite(desktop) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      continue;
    }
    const titleParts = parts.slice(9);
    const rawTitle = titleParts.join(" ").trim();
    const title = sanitizeWindowText(rawTitle);
    windows.push({
      id,
      desktop,
      pid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
      geometry: { x, y, width, height },
      wmClass: safeWmClass,
      ...(includeTitles && title ? { title } : {}),
      titlePresent: Boolean(rawTitle),
    });
  }
  return windows;
}

function unavailableWindowsResult(action: "windows.list" | "windows.focus", reason: string) {
  return {
    ok: true,
    tool: "linux_desktop",
    action,
    available: false,
    reason,
    windows: [],
    count: 0,
    total: 0,
    truncated: false,
    guidance:
      "Use Gateway browser, nodes, or consented screen.capture/read on Wayland; generic native window list/focus is only available through explicit X11 compatibility.",
  };
}

function findDesktopApp(appId: string, host?: LinuxDesktopHostOptions) {
  const resolved = resolveHostOptions(host);
  const dirs = [
    { dir: path.join(resolved.xdgDataHome, "applications"), source: "user" as const },
    ...resolved.xdgDataDirs.map((dir) => ({
      dir: path.join(dir, "applications"),
      source: "system" as const,
    })),
  ];

  for (const { dir, source } of dirs) {
    const files: string[] = [];
    walkDesktopFiles(dir, files);
    for (const filePath of files) {
      try {
        const app = parseDesktopFile({ filePath, appDir: dir, source });
        if (app?.id === appId) {
          return { ...app, filePath, appDir: dir };
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export async function launchLinuxDesktopApp(params: {
  appId: unknown;
  allowedAppIds?: string[];
  allowedAppLaunchers?: LinuxDesktopPluginConfig["allowedAppLaunchers"];
  host?: LinuxDesktopHostOptions;
}) {
  if (typeof params.appId !== "string" || !isValidDesktopAppId(params.appId)) {
    fail(
      "LINUX_DESKTOP_INVALID_APP_ID",
      "apps.launch",
      "apps.launch requires a valid XDG desktop entry id",
    );
  }
  const host = resolveHostOptions(params.host);
  if (host.platform !== "linux") {
    fail("LINUX_DESKTOP_UNSUPPORTED_PLATFORM", "apps.launch", "apps.launch requires Linux", {
      platform: host.platform,
    });
  }
  const allowedAppIds = normalizedAppIdAllowlist(params.allowedAppIds);
  if (!allowedAppIds.has(params.appId)) {
    fail("LINUX_DESKTOP_APP_NOT_ALLOWED", "apps.launch", "app launch is not allowlisted", {
      appId: params.appId,
    });
  }
  const app = findDesktopApp(params.appId, params.host);
  if (!app) {
    fail("LINUX_DESKTOP_APP_NOT_FOUND", "apps.launch", "desktop entry not found", {
      appId: params.appId,
    });
  }
  if (app.terminal) {
    fail(
      "LINUX_DESKTOP_APP_TERMINAL_UNSUPPORTED",
      "apps.launch",
      "terminal desktop entries are not supported for app launch",
      {
        appId: params.appId,
      },
    );
  }
  if (app.hidden) {
    fail(
      "LINUX_DESKTOP_APP_HIDDEN_UNSUPPORTED",
      "apps.launch",
      "hidden desktop entries are not supported for app launch",
      {
        appId: params.appId,
      },
    );
  }
  if (app.noDisplay) {
    fail(
      "LINUX_DESKTOP_APP_NO_DISPLAY_UNSUPPORTED",
      "apps.launch",
      "NoDisplay desktop entries are not supported for app launch",
      {
        appId: params.appId,
      },
    );
  }
  if (!app.launcherAvailable) {
    fail(
      "LINUX_DESKTOP_APP_LAUNCHER_UNSUPPORTED",
      "apps.launch",
      "desktop entry does not expose a supported app launcher",
      {
        appId: params.appId,
      },
    );
  }
  const launcherTrust = appLauncherTrust({
    app,
    allowedLaunchers: normalizedAppLauncherAllowlist(params.allowedAppLaunchers),
  });
  if (launcherTrust !== "trusted-system" && launcherTrust !== "fingerprint-match") {
    fail(
      "LINUX_DESKTOP_APP_LAUNCHER_FINGERPRINT_REQUIRED",
      "apps.launch",
      "user or untrusted desktop entries require an allowedAppLaunchers id and sha256 fingerprint match",
      {
        appId: params.appId,
        source: app.source,
        launcherTrust,
      },
    );
  }
  ensureBackendCommandAvailable({
    command: "gio",
    action: "apps.launch",
    host,
    hostOptions: params.host,
  });
  try {
    await host.runCommand("gio", ["launch", app.filePath], {
      env: host.subprocessEnv,
      timeoutMs: 5000,
    });
  } catch (err) {
    fail("LINUX_DESKTOP_APP_LAUNCH_FAILED", "apps.launch", "desktop app launch failed", {
      appId: params.appId,
      launcher: "gio",
      reason: sanitizeDiagnosticText(err),
    });
  }
  return {
    ok: true,
    tool: "linux_desktop",
    action: "apps.launch",
    launched: true,
    launcher: "gio",
    app: {
      id: app.id,
      name: app.name,
      source: app.source,
      terminal: app.terminal,
      launcherTrust,
    },
  };
}

export async function listLinuxWindows(params: {
  includeTitles?: boolean;
  maxResults?: number;
  config?: LinuxDesktopPluginConfig;
  host?: LinuxDesktopHostOptions;
}) {
  const host = resolveHostOptions(params.host);
  const maxResults = clampLimit(params.maxResults, 100, 500);
  if (host.platform !== "linux") {
    return unavailableWindowsResult("windows.list", "unsupported platform");
  }
  if (isWaylandSession(host)) {
    return unavailableWindowsResult("windows.list", "wayland unsupported");
  }
  if (!isX11Session(host)) {
    return unavailableWindowsResult("windows.list", "x11 display unavailable");
  }
  if (params.config?.windows?.enabled !== true) {
    return unavailableWindowsResult("windows.list", "x11 window compatibility disabled");
  }
  if (params.config?.windows?.allowX11 !== true) {
    return unavailableWindowsResult("windows.list", "x11 window compatibility disabled");
  }
  if (
    !backendCommandAvailableForAction({
      command: "wmctrl",
      host,
      hostOptions: params.host,
    })
  ) {
    return unavailableWindowsResult("windows.list", "wmctrl unavailable");
  }

  const includeTitles =
    params.includeTitles === true && params.config?.windows?.includeTitles === true;
  let windows: LinuxWindow[];
  try {
    const result = await host.runCommand("wmctrl", ["-lpGx"], {
      env: host.subprocessEnv,
      timeoutMs: 3000,
    });
    windows = parseWmctrlWindows(result.stdout, includeTitles);
  } catch (err) {
    return {
      ...unavailableWindowsResult("windows.list", "wmctrl unavailable"),
      error: sanitizeDiagnosticText(err),
    };
  }

  windows.sort((a, b) => a.desktop - b.desktop || a.wmClass.localeCompare(b.wmClass));
  return {
    ok: true,
    tool: "linux_desktop",
    action: "windows.list",
    available: true,
    backend: "wmctrl",
    includeTitles,
    count: Math.min(windows.length, maxResults),
    total: windows.length,
    truncated: windows.length > maxResults,
    windows: windows.slice(0, maxResults),
  };
}

export async function focusLinuxWindow(params: {
  windowId: unknown;
  config?: LinuxDesktopPluginConfig;
  host?: LinuxDesktopHostOptions;
}) {
  const windowId = params.windowId;
  if (typeof windowId !== "string" || !/^0x[0-9a-fA-F]+$/.test(windowId)) {
    fail("LINUX_DESKTOP_INVALID_WINDOW_ID", "windows.focus", "windows.focus requires windowId");
  }
  const config = params.config ?? {};
  const host = resolveHostOptions(params.host);
  if (host.platform !== "linux") {
    fail("LINUX_DESKTOP_UNSUPPORTED_PLATFORM", "windows.focus", "windows.focus requires Linux", {
      platform: host.platform,
    });
  }
  if (config.windows?.enabled !== true) {
    fail(
      "LINUX_DESKTOP_WINDOWS_NOT_ENABLED",
      "windows.focus",
      "windows.focus requires plugins.entries.linux-desktop.config.windows.enabled=true",
    );
  }
  if (isWaylandSession(host)) {
    fail(
      "LINUX_DESKTOP_WINDOWS_WAYLAND_UNSUPPORTED",
      "windows.focus",
      "generic native window focus is unsupported on GNOME/Wayland",
    );
  }
  if (!isX11Session(host)) {
    fail(
      "LINUX_DESKTOP_WINDOWS_X11_UNAVAILABLE",
      "windows.focus",
      "windows.focus requires an X11 DISPLAY",
    );
  }
  if (config.windows?.allowX11 !== true) {
    fail(
      "LINUX_DESKTOP_WINDOWS_X11_DISABLED",
      "windows.focus",
      "windows.focus requires windows.allowX11=true",
    );
  }
  ensureBackendCommandAvailable({
    command: "wmctrl",
    action: "windows.focus",
    host,
    hostOptions: params.host,
  });

  const list = await listLinuxWindows({ config, host: params.host, maxResults: 500 });
  if (!list.available) {
    fail("LINUX_DESKTOP_WINDOWS_UNAVAILABLE", "windows.focus", "window inventory unavailable", {
      reason: "reason" in list ? list.reason : "unavailable",
    });
  }
  const window = list.windows.find((entry) => entry.id.toLowerCase() === windowId.toLowerCase());
  if (!window) {
    fail("LINUX_DESKTOP_WINDOW_NOT_FOUND", "windows.focus", "window id not found", {
      windowId,
    });
  }
  const allowedClasses = normalizedWindowClassAllowlist(config.windows?.allowedFocusClasses);
  if (!allowedClasses.has(window.wmClass)) {
    fail(
      "LINUX_DESKTOP_WINDOW_CLASS_NOT_ALLOWED",
      "windows.focus",
      "window class is not allowlisted",
      {
        windowId,
        wmClass: window.wmClass,
      },
    );
  }

  try {
    await host.runCommand("wmctrl", ["-ia", windowId], {
      env: host.subprocessEnv,
      timeoutMs: 3000,
    });
  } catch (err) {
    fail("LINUX_DESKTOP_WINDOW_FOCUS_FAILED", "windows.focus", "window focus failed", {
      windowId,
      wmClass: window.wmClass,
      reason: sanitizeDiagnosticText(err),
    });
  }

  return {
    ok: true,
    tool: "linux_desktop",
    action: "windows.focus",
    available: true,
    backend: "wmctrl",
    focused: true,
    window,
  };
}

function readUsbDevice(dir: string): UsbDevice | null {
  const vendorId = readUsbHexText(path.join(dir, "idVendor"), 4);
  const productId = readUsbHexText(path.join(dir, "idProduct"), 4);
  if (!vendorId || !productId) {
    return null;
  }
  const busNumber = readUsbDecimalText(path.join(dir, "busnum"));
  const deviceNumber = readUsbDecimalText(path.join(dir, "devnum"));
  return {
    id: usbDeviceId({ busNumber, deviceNumber, dir }),
    busNumber,
    deviceNumber,
    vendorId,
    productId,
    manufacturer: readSanitizedTextIfExists(path.join(dir, "manufacturer")),
    product: readSanitizedTextIfExists(path.join(dir, "product")),
    speed: readUsbSpeedText(path.join(dir, "speed")),
    deviceClass: readUsbHexText(path.join(dir, "bDeviceClass"), 2),
    driver: readSanitizedLinkTargetBase(path.join(dir, "driver")),
    serialPresent: Boolean(readTextIfExists(path.join(dir, "serial"))),
  };
}

export function listLinuxUsbDevices(
  params: {
    maxResults?: number;
    host?: LinuxDesktopHostOptions;
  } = {},
) {
  const host = resolveHostOptions(params.host);
  if (host.platform !== "linux") {
    return {
      ok: true,
      tool: "linux_desktop",
      action: "devices.usb",
      available: false,
      reason: "unsupported platform",
      readOnly: true,
      count: 0,
      total: 0,
      truncated: false,
      devices: [],
      redaction: {
        serialNumbers: "omitted",
      },
    };
  }
  const devicesRoot = path.join(host.sysRoot, "bus/usb/devices");
  const maxResults = clampLimit(params.maxResults, 200, 1000);
  const devices: UsbDevice[] = [];
  let available = true;
  try {
    for (const entry of fs.readdirSync(devicesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const devicePath = path.join(devicesRoot, entry.name);
      if (!resolvedPathStaysInside(host.sysRoot, devicePath)) {
        continue;
      }
      const device = readUsbDevice(devicePath);
      if (device) {
        devices.push(device);
      }
    }
  } catch {
    available = false;
  }

  devices.sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    tool: "linux_desktop",
    action: "devices.usb",
    available,
    readOnly: true,
    count: Math.min(devices.length, maxResults),
    total: devices.length,
    truncated: devices.length > maxResults,
    devices: devices.slice(0, maxResults),
    redaction: {
      serialNumbers: "omitted",
    },
  };
}

function normalizePlayerId(value: string) {
  const trimmed = value.trim();
  const withoutPrefix = trimmed.startsWith(MPRIS_PREFIX)
    ? trimmed.slice(MPRIS_PREFIX.length)
    : trimmed;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(withoutPrefix) ||
    SENSITIVE_IDENTIFIER_SEGMENT_RE.test(withoutPrefix)
  ) {
    return undefined;
  }
  return withoutPrefix;
}

function mprisServiceName(playerId: string) {
  return `${MPRIS_PREFIX}${playerId}`;
}

function parseBusctlServices(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((service) => service.startsWith(MPRIS_PREFIX))
    .map((service) => normalizePlayerId(service))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({
      id,
      service: mprisServiceName(id),
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

function parseBusctlStringProperty(stdout: string) {
  const match = stdout.trim().match(/^s\s+"(.*)"$/);
  return match?.[1] ?? undefined;
}

function sanitizeMediaStatus(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  if (value === "Playing" || value === "Paused" || value === "Stopped") {
    return value;
  }
  const sanitized = sanitizeDiagnosticText(value).trim();
  return sanitized || "unknown";
}

export async function listLinuxMediaPlayers(
  params: {
    maxResults?: number;
    allowedMediaPlayers?: string[];
    allowedMediaActions?: MediaControlAction[];
    host?: LinuxDesktopHostOptions;
  } = {},
) {
  const host = resolveHostOptions(params.host);
  const maxResults = clampLimit(params.maxResults, 50, 200);
  const allowedPlayers = normalizedMediaPlayerAllowlist(params.allowedMediaPlayers);
  const allowedActionCount = normalizedMediaActionAllowlist(params.allowedMediaActions).size;
  if (host.platform !== "linux") {
    return {
      ok: true,
      tool: "linux_desktop",
      action: "media.status",
      available: false,
      reason: "unsupported platform",
      players: [],
      count: 0,
      total: 0,
      truncated: false,
    };
  }
  if (!host.env.DBUS_SESSION_BUS_ADDRESS) {
    return {
      ok: true,
      tool: "linux_desktop",
      action: "media.status",
      available: false,
      reason: "session bus unavailable",
      players: [],
      count: 0,
      total: 0,
      truncated: false,
    };
  }
  if (
    !backendCommandAvailableForAction({
      command: "busctl",
      host,
      hostOptions: params.host,
    })
  ) {
    return {
      ok: true,
      tool: "linux_desktop",
      action: "media.status",
      available: false,
      reason: "busctl unavailable",
      players: [],
      count: 0,
      total: 0,
      truncated: false,
    };
  }
  let services: Array<{ id: string; service: string }> = [];
  try {
    const result = await host.runCommand(
      "busctl",
      ["--user", "--list", "--no-pager", "--no-legend"],
      {
        env: host.subprocessEnv,
        timeoutMs: 3000,
      },
    );
    services = parseBusctlServices(result.stdout);
  } catch (err) {
    return {
      ok: true,
      tool: "linux_desktop",
      action: "media.status",
      available: false,
      reason: "mpris unavailable",
      error: sanitizeDiagnosticText(err),
      players: [],
      count: 0,
      total: 0,
      truncated: false,
    };
  }

  const listedServices = services.slice(0, maxResults);
  const players = [];
  for (const service of listedServices) {
    let playbackStatus: string | undefined;
    try {
      const status = await host.runCommand(
        "busctl",
        [
          "--user",
          "get-property",
          service.service,
          "/org/mpris/MediaPlayer2",
          "org.mpris.MediaPlayer2.Player",
          "PlaybackStatus",
        ],
        { env: host.subprocessEnv, timeoutMs: 3000 },
      );
      playbackStatus = sanitizeMediaStatus(parseBusctlStringProperty(status.stdout));
    } catch {
      playbackStatus = "unknown";
    }
    players.push({
      id: service.id,
      service: service.service,
      playbackStatus,
      controlAllowed: allowedPlayers.has(service.id) && allowedActionCount > 0,
      controlActionCount: allowedPlayers.has(service.id) ? allowedActionCount : 0,
    });
  }

  return {
    ok: true,
    tool: "linux_desktop",
    action: "media.status",
    available: true,
    count: players.length,
    total: services.length,
    truncated: services.length > maxResults,
    players,
  };
}

export async function controlLinuxMedia(params: {
  player: unknown;
  mediaAction: unknown;
  allowedMediaPlayers?: string[];
  allowedMediaActions?: MediaControlAction[];
  host?: LinuxDesktopHostOptions;
}) {
  if (typeof params.player !== "string") {
    fail("LINUX_DESKTOP_INVALID_MEDIA_PLAYER", "media.control", "media.control requires player");
  }
  const playerId = normalizePlayerId(params.player);
  if (!playerId) {
    fail("LINUX_DESKTOP_INVALID_MEDIA_PLAYER", "media.control", "invalid MPRIS player id");
  }
  if (!MEDIA_CONTROL_ACTIONS.includes(params.mediaAction as MediaControlAction)) {
    fail("LINUX_DESKTOP_INVALID_MEDIA_ACTION", "media.control", "invalid media control action", {
      mediaAction: params.mediaAction,
    });
  }
  const host = resolveHostOptions(params.host);
  if (host.platform !== "linux") {
    fail("LINUX_DESKTOP_UNSUPPORTED_PLATFORM", "media.control", "media.control requires Linux", {
      platform: host.platform,
    });
  }
  if (!host.env.DBUS_SESSION_BUS_ADDRESS) {
    fail(
      "LINUX_DESKTOP_SESSION_BUS_UNAVAILABLE",
      "media.control",
      "media.control requires a user session bus",
    );
  }
  const allowedPlayers = normalizedMediaPlayerAllowlist(params.allowedMediaPlayers);
  if (!allowedPlayers.has(playerId)) {
    fail(
      "LINUX_DESKTOP_MEDIA_PLAYER_NOT_ALLOWED",
      "media.control",
      "media player is not allowlisted",
      {
        player: playerId,
      },
    );
  }
  const allowedActions = normalizedMediaActionAllowlist(params.allowedMediaActions);
  if (!allowedActions.has(params.mediaAction as MediaControlAction)) {
    fail(
      "LINUX_DESKTOP_MEDIA_ACTION_NOT_ALLOWED",
      "media.control",
      "media action is not allowlisted",
      {
        mediaAction: params.mediaAction,
      },
    );
  }
  ensureBackendCommandAvailable({
    command: "busctl",
    action: "media.control",
    host,
    hostOptions: params.host,
  });
  const methodByAction: Record<MediaControlAction, string> = {
    play: "Play",
    pause: "Pause",
    playPause: "PlayPause",
    next: "Next",
    previous: "Previous",
    stop: "Stop",
  };
  try {
    await host.runCommand(
      "busctl",
      [
        "--user",
        "call",
        mprisServiceName(playerId),
        "/org/mpris/MediaPlayer2",
        "org.mpris.MediaPlayer2.Player",
        methodByAction[params.mediaAction as MediaControlAction],
      ],
      { env: host.subprocessEnv, timeoutMs: 3000 },
    );
  } catch (err) {
    fail("LINUX_DESKTOP_MEDIA_CONTROL_FAILED", "media.control", "media control failed", {
      player: playerId,
      mediaAction: params.mediaAction,
      reason: sanitizeDiagnosticText(err),
    });
  }
  return {
    ok: true,
    tool: "linux_desktop",
    action: "media.control",
    player: playerId,
    service: mprisServiceName(playerId),
    mediaAction: params.mediaAction,
    controlled: true,
  };
}

function screenCaptureTarget(value: unknown): ScreenCaptureTarget | undefined {
  if (value === undefined) {
    return undefined;
  }
  return SCREEN_CAPTURE_TARGETS.includes(value as ScreenCaptureTarget)
    ? (value as ScreenCaptureTarget)
    : undefined;
}

function resolveScreenCaptureOutputDir(config: LinuxDesktopPluginConfig) {
  const configuredOutputDir = config.screenCapture?.outputDir;
  if (configuredOutputDir !== undefined && typeof configuredOutputDir !== "string") {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_OUTPUT_DIR_INVALID",
      "screen.capture",
      "screen capture outputDir must be a string path under output/",
    );
  }
  const configured = configuredOutputDir?.trim();
  const rawOutputDir = configured || DEFAULT_SCREEN_CAPTURE_OUTPUT_DIR;
  const outputDir = rawOutputDir.replaceAll("\\", "/").replace(/\/+$/, "");
  if (path.isAbsolute(rawOutputDir) || outputDir.split("/").includes("..")) {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_OUTPUT_DIR_INVALID",
      "screen.capture",
      "screen capture outputDir must be relative and stay inside output/",
    );
  }
  if (outputDir !== "output" && !outputDir.startsWith("output/")) {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_OUTPUT_DIR_INVALID",
      "screen.capture",
      "screen capture outputDir must stay inside output/",
    );
  }
  if (
    outputDir
      .split("/")
      .slice(1)
      .some((part) => !OUTPUT_ARTIFACT_SEGMENT_RE.test(part))
  ) {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_OUTPUT_DIR_INVALID",
      "screen.capture",
      "screen capture outputDir segments must be safe output/ path segments",
      { outputDir },
    );
  }
  return outputDir;
}

function resolveScreenCaptureTimeoutMs(config: LinuxDesktopPluginConfig) {
  const timeoutMs = config.screenCapture?.timeoutMs;
  if (timeoutMs === undefined) {
    return 120000;
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000
  ) {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_TIMEOUT_INVALID",
      "screen.capture",
      "screen capture timeoutMs must be an integer from 1 to 300000",
      { timeoutMs },
    );
  }
  return timeoutMs;
}

function resolveOutputArtifactPath(
  rawPath: unknown,
  action: "screen.capture" | "screen.read",
  workspaceDir = process.cwd(),
) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    fail(
      "LINUX_DESKTOP_SCREEN_ARTIFACT_REQUIRED",
      action,
      "screen artifact path must be a relative path under output/",
    );
  }
  const normalized = rawPath.trim().replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized === "output" ||
    !normalized.startsWith("output/") ||
    normalized.split("/").includes("..")
  ) {
    fail(
      "LINUX_DESKTOP_SCREEN_ARTIFACT_INVALID",
      action,
      "screen artifact path must stay under output/",
    );
  }
  const absolute = path.resolve(workspaceDir, normalized);
  const outputRoot = path.resolve(workspaceDir, "output");
  if (absolute !== outputRoot && !absolute.startsWith(`${outputRoot}${path.sep}`)) {
    fail(
      "LINUX_DESKTOP_SCREEN_ARTIFACT_INVALID",
      action,
      "screen artifact path must stay under output/",
    );
  }
  const pathParts = normalized.split("/");
  if (pathParts.slice(1, -1).some((part) => !OUTPUT_ARTIFACT_SEGMENT_RE.test(part))) {
    fail(
      "LINUX_DESKTOP_SCREEN_ARTIFACT_INVALID",
      action,
      "screen artifact directory segments must be safe output/ path segments",
      { artifactPath: normalized },
    );
  }
  return {
    relativePath: normalized,
    absolutePath: absolute,
  };
}

function assertScreenCaptureArtifactPath(relativePath: string) {
  const basename = path.posix.basename(relativePath);
  const match = basename.match(SCREEN_CAPTURE_ARTIFACT_RE);
  if (!match) {
    fail(
      "LINUX_DESKTOP_SCREEN_ARTIFACT_UNTRUSTED",
      "screen.read",
      "screen.read artifactPath must reference a linux_desktop screen.capture artifact",
      { artifactPath: relativePath },
    );
  }
  return {
    target: match[1],
    capturedAt: match[2],
  };
}

function assertPngScreenArtifact(filePath: string, action: "screen.capture" | "screen.read") {
  let header: Buffer;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      header = Buffer.alloc(24);
      fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    fail(
      action === "screen.capture"
        ? "LINUX_DESKTOP_SCREEN_CAPTURE_ARTIFACT_FAILED"
        : "LINUX_DESKTOP_SCREEN_READ_ARTIFACT_FAILED",
      action,
      "screen artifact could not be read",
      { reason: sanitizeDiagnosticText(err) },
    );
  }
  const dimensions = readPngDimensions(header);
  if (!dimensions) {
    fail(
      action === "screen.capture"
        ? "LINUX_DESKTOP_SCREEN_CAPTURE_ARTIFACT_INVALID"
        : "LINUX_DESKTOP_SCREEN_ARTIFACT_INVALID",
      action,
      "screen artifact is not a valid PNG image",
    );
  }
  return dimensions;
}

function readPngDimensions(header: Buffer) {
  if (
    header.length < 24 ||
    !header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    header.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return undefined;
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return undefined;
  }
  return { width, height };
}

function assertScreenArtifactSize(params: {
  bytes: number;
  action: "screen.capture" | "screen.read";
  artifactPath?: string;
}) {
  if (params.bytes > MAX_SCREEN_CAPTURE_ARTIFACT_BYTES) {
    fail(
      params.action === "screen.capture"
        ? "LINUX_DESKTOP_SCREEN_CAPTURE_ARTIFACT_TOO_LARGE"
        : "LINUX_DESKTOP_SCREEN_ARTIFACT_TOO_LARGE",
      params.action,
      "screen artifact is too large",
      {
        artifactPath: params.artifactPath,
        bytes: params.bytes,
        maxBytes: MAX_SCREEN_CAPTURE_ARTIFACT_BYTES,
      },
    );
  }
}

function assertOutputPathHasNoSymlinks(params: {
  absolutePath: string;
  action: "screen.capture" | "screen.read";
  workspaceDir?: string;
  includeLeaf?: boolean;
  message: string;
}) {
  const outputRoot = path.resolve(params.workspaceDir ?? process.cwd(), "output");
  const relative = path.relative(outputRoot, params.absolutePath);
  const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
  const checkParts = params.includeLeaf === true ? parts : parts.slice(0, -1);
  let current = outputRoot;
  const pathsToCheck = [outputRoot];
  for (const part of checkParts) {
    current = path.join(current, part);
    pathsToCheck.push(current);
  }
  for (const candidate of pathsToCheck) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        fail(
          params.action === "screen.capture"
            ? "LINUX_DESKTOP_SCREEN_CAPTURE_OUTPUT_DIR_INVALID"
            : "LINUX_DESKTOP_SCREEN_ARTIFACT_INVALID",
          params.action,
          params.message,
        );
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        fail(
          params.action === "screen.capture"
            ? "LINUX_DESKTOP_SCREEN_CAPTURE_OUTPUT_DIR_INVALID"
            : "LINUX_DESKTOP_SCREEN_ARTIFACT_INVALID",
          params.action,
          params.message,
          { reason: sanitizeDiagnosticText(err) },
        );
      }
    }
  }
}

function screenCaptureManifestPath(artifactPath: string) {
  return `${artifactPath}.json`;
}

function writeScreenCaptureManifest(params: {
  artifactPath: string;
  relativePath: string;
  workspaceDir: string;
  bytes: number;
  dimensions: { width: number; height: number };
  target: ScreenCaptureTarget | "interactive";
  capturedAt: string;
}) {
  const manifestPath = screenCaptureManifestPath(params.artifactPath);
  const manifest = {
    kind: SCREEN_CAPTURE_MANIFEST_KIND,
    version: 1,
    artifact: {
      path: params.relativePath,
      bytes: params.bytes,
      dimensions: params.dimensions,
    },
    capture: {
      target: params.target,
      capturedAt: params.capturedAt,
      portal: {
        provider: "xdg-desktop-portal",
        interactive: true,
      },
      consent: {
        required: true,
        mode: SCREEN_CAPTURE_CONSENT_MODE,
        granted: true,
      },
    },
  };
  assertOutputPathHasNoSymlinks({
    absolutePath: manifestPath,
    action: "screen.capture",
    workspaceDir: params.workspaceDir,
    includeLeaf: true,
    message: "screen capture manifest path must not contain symlinks",
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    path: manifestPath,
    relativePath: path.relative(params.workspaceDir, manifestPath).replaceAll(path.sep, "/"),
  };
}

function nextScreenCaptureArtifactPath(params: {
  outputDir: string;
  workspaceDir: string;
  target: ScreenCaptureTarget | "interactive";
  timestamp: string;
}) {
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`;
    const outputPath = path.join(
      params.outputDir,
      `linux-desktop-${params.target}-${params.timestamp}${suffix}.png`,
    );
    const relativePath = path.relative(params.workspaceDir, outputPath).replaceAll(path.sep, "/");
    const manifestPath = screenCaptureManifestPath(outputPath);
    if (!fs.existsSync(outputPath) && !fs.existsSync(manifestPath)) {
      return { outputPath, relativePath };
    }
  }
  return fail(
    "LINUX_DESKTOP_SCREEN_CAPTURE_ARTIFACT_FAILED",
    "screen.capture",
    "screen capture could not allocate a unique output artifact path",
  );
}

function readScreenCaptureManifest(params: {
  artifactPath: string;
  absolutePath: string;
  bytes: number;
  dimensions: { width: number; height: number };
  expectedTarget: string;
  expectedCapturedAt: string;
}) {
  const manifestPath = screenCaptureManifestPath(params.absolutePath);
  let manifest: unknown;
  try {
    const manifestStat = fs.lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      fail(
        "LINUX_DESKTOP_SCREEN_ARTIFACT_UNTRUSTED",
        "screen.read",
        "screen.read artifact manifest is not a regular file",
        { artifactPath: params.artifactPath },
      );
    }
    if (manifestStat.size > MAX_SCREEN_CAPTURE_MANIFEST_BYTES) {
      fail(
        "LINUX_DESKTOP_SCREEN_ARTIFACT_UNTRUSTED",
        "screen.read",
        "screen.read artifact manifest is too large",
        {
          artifactPath: params.artifactPath,
          maxBytes: MAX_SCREEN_CAPTURE_MANIFEST_BYTES,
        },
      );
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    if (err instanceof LinuxDesktopToolError) {
      throw err;
    }
    fail(
      "LINUX_DESKTOP_SCREEN_ARTIFACT_UNTRUSTED",
      "screen.read",
      "screen.read artifact is missing a linux_desktop screen.capture manifest",
      {
        artifactPath: params.artifactPath,
        reason: sanitizeDiagnosticText(err),
      },
    );
  }
  const payload =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>)
      : {};
  const artifact =
    payload.artifact && typeof payload.artifact === "object" && !Array.isArray(payload.artifact)
      ? (payload.artifact as Record<string, unknown>)
      : {};
  const dimensions =
    artifact.dimensions &&
    typeof artifact.dimensions === "object" &&
    !Array.isArray(artifact.dimensions)
      ? (artifact.dimensions as Record<string, unknown>)
      : {};
  const capture =
    payload.capture && typeof payload.capture === "object" && !Array.isArray(payload.capture)
      ? (payload.capture as Record<string, unknown>)
      : {};
  const portal =
    capture.portal && typeof capture.portal === "object" && !Array.isArray(capture.portal)
      ? (capture.portal as Record<string, unknown>)
      : {};
  const consent =
    capture.consent && typeof capture.consent === "object" && !Array.isArray(capture.consent)
      ? (capture.consent as Record<string, unknown>)
      : undefined;
  const target = String(capture.target);
  if (
    payload.kind !== SCREEN_CAPTURE_MANIFEST_KIND ||
    payload.version !== 1 ||
    artifact.path !== params.artifactPath ||
    artifact.bytes !== params.bytes ||
    dimensions.width !== params.dimensions.width ||
    dimensions.height !== params.dimensions.height ||
    capture.capturedAt !== params.expectedCapturedAt ||
    !["screen", "window", "area", "activeWindow", "interactive"].includes(target) ||
    target !== params.expectedTarget ||
    portal.provider !== "xdg-desktop-portal" ||
    portal.interactive !== true ||
    consent?.required !== true ||
    consent.mode !== SCREEN_CAPTURE_CONSENT_MODE ||
    consent.granted !== true
  ) {
    fail(
      "LINUX_DESKTOP_SCREEN_ARTIFACT_UNTRUSTED",
      "screen.read",
      "screen.read artifact manifest does not match a linux_desktop screen.capture artifact",
      { artifactPath: params.artifactPath },
    );
  }
  return {
    target,
    capturedAt: capture.capturedAt,
    portal: {
      provider: "xdg-desktop-portal",
      interactive: true,
    },
    consent: {
      required: true,
      mode: SCREEN_CAPTURE_CONSENT_MODE,
      granted: true,
    },
  };
}

function copyPortalScreenshotArtifact(params: {
  uri: string;
  outputDir: string;
  workspaceDir: string;
  target?: ScreenCaptureTarget;
}) {
  if (!params.uri.startsWith("file://")) {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_URI_UNSUPPORTED",
      "screen.capture",
      "portal returned an unsupported screenshot URI",
      { scheme: params.uri.split(":", 1)[0] || "unknown" },
    );
  }
  let sourcePath: string;
  let stat: fs.Stats;
  try {
    sourcePath = fileURLToPath(params.uri);
    if (fs.lstatSync(sourcePath).isSymbolicLink()) {
      fail(
        "LINUX_DESKTOP_SCREEN_CAPTURE_URI_INVALID",
        "screen.capture",
        "portal URI must not reference a symlink",
      );
    }
    stat = fs.statSync(sourcePath);
  } catch (err) {
    if (err instanceof LinuxDesktopToolError) {
      throw err;
    }
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_ARTIFACT_FAILED",
      "screen.capture",
      "portal screenshot artifact could not be read",
      { reason: sanitizeDiagnosticText(err) },
    );
  }
  if (!stat.isFile()) {
    fail("LINUX_DESKTOP_SCREEN_CAPTURE_URI_INVALID", "screen.capture", "portal URI is not a file");
  }
  assertScreenArtifactSize({ bytes: stat.size, action: "screen.capture" });
  const outputDir = path.resolve(params.workspaceDir, params.outputDir);
  assertOutputPathHasNoSymlinks({
    absolutePath: outputDir,
    action: "screen.capture",
    workspaceDir: params.workspaceDir,
    includeLeaf: true,
    message: "screen capture outputDir must not contain symlinks",
  });
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  const target = params.target ?? "interactive";
  const dimensions = assertPngScreenArtifact(sourcePath, "screen.capture");
  const { outputPath, relativePath } = nextScreenCaptureArtifactPath({
    outputDir,
    workspaceDir: params.workspaceDir,
    target,
    timestamp,
  });
  let manifest: { path: string; relativePath: string };
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    assertOutputPathHasNoSymlinks({
      absolutePath: outputDir,
      action: "screen.capture",
      workspaceDir: params.workspaceDir,
      includeLeaf: true,
      message: "screen capture outputDir must not contain symlinks",
    });
    assertOutputPathHasNoSymlinks({
      absolutePath: outputPath,
      action: "screen.capture",
      workspaceDir: params.workspaceDir,
      includeLeaf: true,
      message: "screen capture artifact path must not contain symlinks",
    });
    fs.copyFileSync(sourcePath, outputPath, fs.constants.COPYFILE_EXCL);
    manifest = writeScreenCaptureManifest({
      artifactPath: outputPath,
      relativePath,
      workspaceDir: params.workspaceDir,
      bytes: stat.size,
      dimensions,
      target,
      capturedAt: timestamp,
    });
  } catch (err) {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_ARTIFACT_FAILED",
      "screen.capture",
      "portal screenshot artifact could not be copied",
      { reason: sanitizeDiagnosticText(err) },
    );
  }
  return {
    path: outputPath,
    relativePath,
    bytes: stat.size,
    manifestRelativePath: manifest.relativePath,
  };
}

export async function captureLinuxScreen(params: {
  screenTarget?: unknown;
  config?: LinuxDesktopPluginConfig;
  host?: LinuxDesktopHostOptions;
}) {
  const config = params.config ?? {};
  if (config.screenCapture?.enabled !== true) {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_NOT_ENABLED",
      "screen.capture",
      "screen capture requires plugins.entries.linux-desktop.config.screenCapture.enabled=true",
    );
  }
  const target = screenCaptureTarget(params.screenTarget);
  if (params.screenTarget !== undefined && !target) {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_TARGET_INVALID",
      "screen.capture",
      "invalid screen capture target",
      { screenTarget: params.screenTarget },
    );
  }
  const outputDir = resolveScreenCaptureOutputDir(config);
  const host = resolveHostOptions(params.host);
  const workspaceDir = host.workspaceDir;
  if (host.platform !== "linux") {
    fail("LINUX_DESKTOP_UNSUPPORTED_PLATFORM", "screen.capture", "screen.capture requires Linux", {
      platform: host.platform,
    });
  }
  if (!host.env.DBUS_SESSION_BUS_ADDRESS) {
    fail(
      "LINUX_DESKTOP_SESSION_BUS_UNAVAILABLE",
      "screen.capture",
      "screen.capture requires a user session bus",
    );
  }
  if (!desktopPortalAvailable(host.dbusServiceDirs)) {
    fail(
      "LINUX_DESKTOP_PORTAL_UNAVAILABLE",
      "screen.capture",
      "screen.capture requires xdg-desktop-portal",
    );
  }
  if (usingDefaultPortalScreenshot(params.host) && !commandAvailable("gdbus", host.env)) {
    fail(
      "LINUX_DESKTOP_BACKEND_UNAVAILABLE",
      "screen.capture",
      "linux_desktop backend command unavailable: gdbus",
      { backend: "gdbus" },
    );
  }
  const timeoutMs = resolveScreenCaptureTimeoutMs(config);
  let portalResult: { uri: string; response: number };
  try {
    portalResult = await host.runPortalScreenshot({
      target,
      timeoutMs,
      env: host.subprocessEnv,
    });
  } catch (err) {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_FAILED",
      "screen.capture",
      "portal screen capture failed or was cancelled",
      { reason: sanitizeDiagnosticText(err) },
    );
  }
  if (portalResult.response !== 0) {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_CANCELLED",
      "screen.capture",
      "portal screen capture was cancelled or denied",
      { response: portalResult.response },
    );
  }
  if (typeof portalResult.uri !== "string" || !portalResult.uri.trim()) {
    fail(
      "LINUX_DESKTOP_SCREEN_CAPTURE_URI_MISSING",
      "screen.capture",
      "portal screen capture response did not include an artifact URI",
    );
  }
  const artifact = copyPortalScreenshotArtifact({
    uri: portalResult.uri,
    outputDir,
    workspaceDir,
    target,
  });
  return {
    ok: true,
    tool: "linux_desktop",
    action: "screen.capture",
    target: target ?? "interactive",
    portal: {
      provider: "xdg-desktop-portal",
      interactive: true,
      response: portalResult.response,
      uriRedacted: true,
    },
    consent: {
      required: true,
      mode: SCREEN_CAPTURE_CONSENT_MODE,
      granted: true,
    },
    artifact: {
      path: artifact.relativePath,
      bytes: artifact.bytes,
      manifestPath: artifact.manifestRelativePath,
    },
  };
}

export async function readLinuxScreen(params: {
  artifactPath?: unknown;
  screenTarget?: unknown;
  config?: LinuxDesktopPluginConfig;
  host?: LinuxDesktopHostOptions;
}) {
  const config = params.config ?? {};
  if (config.screenRead?.enabled !== true) {
    fail(
      "LINUX_DESKTOP_SCREEN_READ_NOT_ENABLED",
      "screen.read",
      "screen read requires plugins.entries.linux-desktop.config.screenRead.enabled=true",
    );
  }
  const host = resolveHostOptions(params.host);
  const workspaceDir = host.workspaceDir;
  if (host.platform !== "linux") {
    fail("LINUX_DESKTOP_UNSUPPORTED_PLATFORM", "screen.read", "screen.read requires Linux", {
      platform: host.platform,
    });
  }
  let artifactPath: string;
  let captured = false;
  if (params.artifactPath !== undefined) {
    if (typeof params.artifactPath !== "string" || !params.artifactPath.trim()) {
      fail(
        "LINUX_DESKTOP_SCREEN_ARTIFACT_REQUIRED",
        "screen.read",
        "screen artifact path must be a non-empty relative path under output/",
      );
    }
    if (params.screenTarget !== undefined) {
      fail(
        "LINUX_DESKTOP_SCREEN_READ_TARGET_WITH_ARTIFACT_UNSUPPORTED",
        "screen.read",
        "screenTarget is only supported when screen.read performs a new portal capture",
        { artifactPath: params.artifactPath },
      );
    }
    artifactPath = resolveOutputArtifactPath(
      params.artifactPath,
      "screen.read",
      workspaceDir,
    ).relativePath;
  } else {
    if (config.screenRead.allowCapture !== true) {
      fail(
        "LINUX_DESKTOP_SCREEN_READ_CAPTURE_NOT_ALLOWED",
        "screen.read",
        "screen.read live capture requires screenRead.allowCapture=true and screenCapture.enabled=true",
      );
    }
    const capture = await captureLinuxScreen({
      screenTarget: params.screenTarget,
      config,
      host: params.host,
    });
    artifactPath = capture.artifact.path;
    captured = true;
  }
  const resolved = resolveOutputArtifactPath(artifactPath, "screen.read", workspaceDir);
  const artifactMetadata = assertScreenCaptureArtifactPath(resolved.relativePath);
  assertOutputPathHasNoSymlinks({
    absolutePath: resolved.absolutePath,
    action: "screen.read",
    workspaceDir,
    includeLeaf: true,
    message: "screen artifact path must not contain symlinks",
  });
  assertOutputPathHasNoSymlinks({
    absolutePath: screenCaptureManifestPath(resolved.absolutePath),
    action: "screen.read",
    workspaceDir,
    includeLeaf: true,
    message: "screen artifact manifest path must not contain symlinks",
  });
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.absolutePath);
  } catch {
    fail("LINUX_DESKTOP_SCREEN_ARTIFACT_NOT_FOUND", "screen.read", "screen artifact not found", {
      artifactPath: resolved.relativePath,
    });
  }
  if (!stat.isFile()) {
    fail("LINUX_DESKTOP_SCREEN_ARTIFACT_INVALID", "screen.read", "screen artifact is not a file", {
      artifactPath: resolved.relativePath,
    });
  }
  assertScreenArtifactSize({
    bytes: stat.size,
    action: "screen.read",
    artifactPath: resolved.relativePath,
  });
  const dimensions = assertPngScreenArtifact(resolved.absolutePath, "screen.read");
  const captureManifest = readScreenCaptureManifest({
    artifactPath: resolved.relativePath,
    absolutePath: resolved.absolutePath,
    bytes: stat.size,
    dimensions,
    expectedTarget: artifactMetadata.target,
    expectedCapturedAt: artifactMetadata.capturedAt,
  });
  return screenImageResult({
    path: resolved.relativePath,
    base64: fs.readFileSync(resolved.absolutePath).toString("base64"),
    artifact: {
      path: resolved.relativePath,
      bytes: stat.size,
      dimensions,
    },
    captured,
    capture: captureManifest,
  });
}

export function createLinuxDesktopTool(api: OpenClawPluginApi, host?: LinuxDesktopHostOptions) {
  const auditValue = (value: unknown) => sanitizeDiagnosticText(String(value));
  const audit = (action: string, extra?: Record<string, unknown>) => {
    const suffix = extra
      ? ` ${Object.entries(extra)
          .map(([key, value]) => `${key}=${auditValue(value)}`)
          .join(" ")}`
      : "";
    api.logger.info(`linux_desktop action=${action} status=ok${suffix}`);
  };
  const auditFailure = (action: string, err: unknown) => {
    const code = err instanceof LinuxDesktopToolError ? err.code : "LINUX_DESKTOP_ERROR";
    api.logger.warn(
      `linux_desktop action=${sanitizeDiagnosticText(action || "unknown")} status=error code=${code}`,
    );
  };

  return {
    name: "linux_desktop",
    label: "Linux desktop",
    description:
      "Optional Gateway Linux desktop tool for status, app inventory, allowlisted app launch, USB inventory, optional X11 window list/focus, allowlisted MPRIS media controls, consented portal screenshots, and screen artifact reading. Does not probe serial numbers, run shell commands, perform provider auth/OCR, or use unsafe Wayland compositor internals.",
    parameters: LinuxDesktopToolSchema,
    async execute(_id: string, params: Record<string, unknown>) {
      const action = readLinuxDesktopAction(params);
      const config = pluginConfig(api);
      try {
        const requestParams = readLinuxDesktopParams(params);
        assertKnownLinuxDesktopParams(requestParams, action);
        switch (action) {
          case "status": {
            ensureActionAllowed(config, "status", "status");
            const details = getLinuxDesktopStatus({ ...host, config });
            audit("status", { supported: details.supported });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
              details,
            };
          }
          case "apps.list": {
            ensureActionAllowed(config, "appsList", "apps.list");
            const details = listLinuxDesktopApps({
              includeHidden:
                typeof requestParams.includeHidden === "boolean"
                  ? requestParams.includeHidden
                  : undefined,
              maxResults: optionalNumberParam(requestParams.maxResults),
              pluginMaxApps: config.maxApps,
              pluginIncludeHidden: config.includeNoDisplayApps,
              allowedAppIds: config.allowedAppIds,
              allowedAppLaunchers: config.allowedAppLaunchers,
              host,
            });
            audit("apps.list", {
              count: details.count,
              total: details.total,
              truncated: details.truncated,
              errorCount: details.errorCount,
              errorsTruncated: details.errorsTruncated,
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
              details,
            };
          }
          case "apps.launch": {
            ensureActionAllowed(config, "appsLaunch", "apps.launch");
            const details = await launchLinuxDesktopApp({
              appId: requestParams.appId,
              allowedAppIds: config.allowedAppIds,
              allowedAppLaunchers: config.allowedAppLaunchers,
              host,
            });
            audit("apps.launch", { launched: details.launched });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
              details,
            };
          }
          case "devices.usb": {
            ensureActionAllowed(config, "devicesUsb", "devices.usb");
            const details = listLinuxUsbDevices({
              maxResults: optionalNumberParam(requestParams.maxResults),
              host,
            });
            audit("devices.usb", {
              count: details.count,
              total: details.total,
              truncated: details.truncated,
              available: details.available,
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
              details,
            };
          }
          case "windows.list": {
            ensureActionAllowed(config, "windowsList", "windows.list");
            const details = await listLinuxWindows({
              includeTitles:
                typeof requestParams.includeTitles === "boolean"
                  ? requestParams.includeTitles
                  : undefined,
              maxResults: optionalNumberParam(requestParams.maxResults),
              config,
              host,
            });
            audit("windows.list", {
              count: details.count,
              total: details.total,
              truncated: details.truncated,
              available: details.available,
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
              details,
            };
          }
          case "windows.focus": {
            ensureActionAllowed(config, "windowsFocus", "windows.focus");
            const details = await focusLinuxWindow({
              windowId: requestParams.windowId,
              config,
              host,
            });
            audit("windows.focus", { focused: true });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
              details,
            };
          }
          case "media.status": {
            ensureActionAllowed(config, "mediaStatus", "media.status");
            const details = await listLinuxMediaPlayers({
              maxResults: optionalNumberParam(requestParams.maxResults),
              allowedMediaPlayers: config.allowedMediaPlayers,
              allowedMediaActions: config.allowedMediaActions,
              host,
            });
            audit("media.status", {
              count: details.count,
              total: details.total,
              truncated: details.truncated,
              available: details.available,
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
              details,
            };
          }
          case "media.control": {
            ensureActionAllowed(config, "mediaControl", "media.control");
            const details = await controlLinuxMedia({
              player: requestParams.player,
              mediaAction: requestParams.mediaAction,
              allowedMediaPlayers: config.allowedMediaPlayers,
              allowedMediaActions: config.allowedMediaActions,
              host,
            });
            audit("media.control", { mediaAction: details.mediaAction, controlled: true });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
              details,
            };
          }
          case "screen.capture": {
            ensureActionAllowed(config, "screenCapture", "screen.capture");
            const details = await captureLinuxScreen({
              screenTarget: requestParams.screenTarget,
              config,
              host,
            });
            audit("screen.capture", {
              target: details.target,
              consentMode: details.consent.mode,
              artifact: "created",
              bytes: details.artifact.bytes,
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
              details,
            };
          }
          case "screen.read": {
            ensureActionAllowed(config, "screenRead", "screen.read");
            const result = await readLinuxScreen({
              artifactPath: requestParams.artifactPath,
              screenTarget: requestParams.screenTarget,
              config,
              host,
            });
            const details = result.details as {
              artifact?: { path?: string; bytes?: number };
              captured?: boolean;
              capture?: {
                target?: string;
                consent?: { mode?: string };
              };
            };
            audit("screen.read", {
              target: details.capture?.target ?? "unknown",
              captured: details.captured ?? "unknown",
              consentMode: details.capture?.consent?.mode ?? "unknown",
              artifact: details.artifact ? "attached" : "unknown",
              bytes: details.artifact?.bytes ?? "unknown",
            });
            return result;
          }
          default:
            return fail("LINUX_DESKTOP_INVALID_ACTION", "unknown", "invalid linux_desktop action", {
              action,
            });
        }
      } catch (err) {
        auditFailure(action, err);
        throw err;
      }
    },
  };
}
