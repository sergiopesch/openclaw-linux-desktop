---
summary: "Optional Linux desktop Gateway tool for app inventory, USB inventory, app launch, X11 window focus, media control, portal screenshots, and screen reading"
read_when:
  - Enabling Linux desktop control for Gateway Realtime voice
  - Testing the linux_desktop plugin tool
  - Adding native Linux desktop actions
title: "Linux Desktop"
---

# Linux Desktop

`linux_desktop` is an external optional plugin tool for Gateway-native Linux desktop
voice work. The current surface is intentionally narrow and policy-gated:

- `status`
- `apps.list`
- `apps.launch`
- `devices.usb`
- `windows.list`
- `windows.focus`
- `media.status`
- `media.control`
- `screen.capture`
- `screen.read`

It is designed to fill gaps that existing Gateway tools do not cover. Continue to
use `browser` for visible web automation, `nodes` for paired node screen/camera/run
capabilities, and tightly scoped `exec` only when a structured tool is not available.

The tool schema and runtime are intentionally strict: top-level parameters must be
a plain object, fields outside the documented set are rejected, result caps are
bounded, app/window/player identifiers use fixed patterns, screen artifact paths
must stay under `output/`, known parameters are accepted only by the actions that
document them, and malformed or action-incompatible parameters fail before any
host command or portal action runs.

Fixed host commands and portal helpers receive a positive-allowlisted subprocess
environment. Desktop/session/runtime variables such as `PATH`, `HOME`, `DISPLAY`,
`WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `XDG_CURRENT_DESKTOP`, `XDG_SESSION_TYPE`,
and `DBUS_SESSION_BUS_ADDRESS` are preserved when present; arbitrary application
environment variables are dropped. Provider, OAuth, token, API key, password,
cloud credential, private-key, and client-secret variables are removed even if a
future desktop allowlist would otherwise match them.
The production/default runner does not use `PATH` to select helper binaries.
Allowed helpers are resolved from trusted root-owned system locations before
execution, and helpers found through user-writable or workspace paths are ignored.

## Enable

The plugin is disabled by default. Install it, then enable the plugin and explicitly allow
the optional tool:

```json
{
  "plugins": {
    "entries": {
      "linux-desktop": { "enabled": true }
    }
  },
  "tools": {
    "alsoAllow": ["linux_desktop"]
  }
}
```

If your config already uses `tools.allow`, do not add `tools.alsoAllow` in the
same scope. Append `linux_desktop` to the existing allowlist instead:

```json
{
  "tools": {
    "allow": [
      "group:fs",
      "group:runtime",
      "group:sessions",
      "group:web",
      "browser",
      "linux_desktop"
    ]
  }
}
```

Per-agent allowlist:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "alsoAllow": ["linux_desktop"] }
      }
    ]
  }
}
```

Restart the Gateway after changing plugin config.
Malformed runtime allowlists fail closed: if a hand-edited or older config bypasses
schema validation and provides a non-array allowlist, `linux_desktop` treats it as
empty policy rather than launching apps, controlling media, or focusing windows.
Runtime allowlist arrays are also filtered through the manifest patterns; invalid
app ids, media players, media actions, or window classes are ignored instead of
enabling actions or changing policy counts. The manifest also rejects
sensitive-looking delimited identifiers such as `token_secret` before runtime
policy can use them. Oversized runtime allowlists are capped to the first unique
valid entries using the same app, media player, media action, and window class
limits as the manifest schema.
Malformed runtime action gates also fail closed. After the plugin and tool are
explicitly enabled, only the read-only MVP actions `status`, `apps.list`, and
`devices.usb` default on when a per-action gate is absent. Later desktop-control
surfaces such as app launch, windows, media, screen capture, and screen read require
their matching `actions.*` gate to be explicitly `true`; a present non-boolean gate
disables that action.
Malformed runtime numeric policy such as non-integer `maxApps` is ignored and
the default bounded cap is used instead.

When testing this plugin from a local checkout against an installed OpenClaw
Gateway, build and link the package once, then restart the Gateway:

```bash
npm install
npm run build
openclaw plugins install --link .
openclaw gateway restart
```

The package keeps `openclaw` as an optional npm peer dependency because the
Gateway host provides the plugin SDK at runtime. Local builds use the focused
type declaration in `types/openclaw-plugin-entry.d.ts` instead of installing the
full OpenClaw dependency tree.

The linked plugin still requires the `plugins.entries.linux-desktop.enabled`
entry and either `tools.alsoAllow`, an existing `tools.allow` list that includes
`linux_desktop`, or a per-agent `linux_desktop` allowlist above.

To verify that Gateway auth and tool policy can reach the tool without running a
full Realtime session, call the Gateway tool RPC directly:

```bash
openclaw gateway call tools.invoke --json \
  --params '{"name":"linux_desktop","args":{"action":"status"}}'

openclaw gateway call tools.invoke --json \
  --params '{"name":"linux_desktop","args":{"action":"apps.list","maxResults":5}}'

openclaw gateway call tools.invoke --json \
  --params '{"name":"linux_desktop","args":{"action":"devices.usb","maxResults":5}}'
```

The validation path calls Gateway `tools.invoke` with `name: "linux_desktop"` for
the read-only MVP actions: `status`, `apps.list`, and `devices.usb`. The evidence
passes only when each response has the Gateway success envelope plus matching
`linux_desktop` tool and action metadata. The `status` response must confirm
Linux desktop support plus the read-only MVP capabilities `status`, `appsList`,
and `devicesUsb`, and it must expose only policy counts rather than raw app,
media, or window allowlists. The `apps.list` response must not expose raw
launcher fields, including nested variants such as `Exec`, `execCommand`,
`command`, or desktop file paths, and it must include bounded inventory metadata
such as `count`, `total`, `truncated`, `apps`, and `errors`; the returned count
must honor the validator's `maxResults: 20` request, equal `apps.length`, and
report `truncated` consistently with `total > count`; parse diagnostics must
also have internally consistent `errorCount`, `errors.length`, and
`errorsTruncated` metadata. The `devices.usb` response must also confirm
`readOnly: true` and `redaction.serialNumbers: "omitted"`, include bounded
inventory metadata such as `available`, `count`, `total`, `truncated`, and
`devices`, honor the same `maxResults: 20` request, require `count` to equal
`devices.length`, report `truncated` consistently with `total > count`, and
device entries must not contain serial-like fields other than the boolean
`serialPresent`. The
evidence output includes only sanitized status fields such as platform, session type,
desktop name, host capability names, policy-enabled capability names, fixed
backend names, policy counts, app counts, USB counts, and USB redaction state.
Only the known backend names `gio`, `wmctrl`, `busctl`, and `gdbus` are preserved
in validation evidence; malformed backend keys are dropped. If backend metadata
is present, validation rejects inconsistent status responses where a
command-backed capability is reported as available while its required backend is
reported unavailable. Validation also rejects status responses where
`enabledCapabilities` claims an action is callable while the matching host
`capabilities` entry is not available. The target policy session is `--session`
when provided; otherwise validation uses the Gateway-reported main session key
and falls back to `main` only for older Gateways that do not report session
defaults. When `--json` is used,
`linuxDesktop.configState` also reports read-only setup booleans such as plugin
entry state, whether a local load path basename looks linked, whether
`linux_desktop` appears in global or target-agent tool policy, and the target
session or agent id. It does not print plugin paths, workspace paths, app names,
USB device names, raw app allowlists, raw media allowlists, raw window class
allowlists, auth tokens, passwords, or provider secrets.

If validation fails:

- `unknown tool`, `tool not found`, or `plugin not found`: install or link the
  plugin, enable `plugins.entries.linux-desktop.enabled=true`, and restart the
  Gateway.
- `not allowed`, `allowlist`, `policy`, or HTTP `403`: allowlist
  `linux_desktop` in `tools.alsoAllow` or the target agent's `tools.alsoAllow`,
  then restart the Gateway.
- HTTP `401`: pass matching Gateway auth with `--token` or `--password`, or run
  validation from the same local OpenClaw config used by the running Gateway.

## Tool Actions

### `status`

Reports Linux desktop capability status:

- platform support
- distro metadata from `/etc/os-release`
- session type and desktop environment from XDG environment variables
- desktop portal service availability
- session bus presence
- fixed backend command availability for `gio`, `wmctrl`, `busctl`, and `gdbus`
- app inventory source availability
- USB sysfs availability
- `windowBackends`, including the `wmctrl` X11 helper state and the explicit
  Wayland strategy `unsupported-generic-window-control`
- native window inventory/focus capability only when X11 is available; GNOME
  Wayland stays unsupported for generic native window control because Wayland
  does not expose a safe generic public API for listing or focusing arbitrary
  application windows
- host `capabilities` and policy-gated `enabledCapabilities`, so callers can
  distinguish "the host supports this" from "this action is currently callable
  under plugin config"
- command-backed capabilities are reported only when the corresponding fixed
  backend binary is present: app launch requires `gio`, X11 window actions require
  `wmctrl`, MPRIS media actions require `busctl`, and portal screen capture
  requires `gdbus` plus `xdg-desktop-portal`
- production backend availability uses the same trusted absolute helper resolution
  as execution, not the Gateway process `PATH`
- when the production/default runner is used, command-backed actions fail with a
  structured `LINUX_DESKTOP_BACKEND_UNAVAILABLE` error before attempting a host
  command if the fixed backend binary is missing
- non-sensitive policy counts, such as allowlisted app count or media action
  count, without exposing the raw allowlist entries
- distro, session, and desktop labels are sanitized before they are returned, so
  token-shaped values and personal filesystem paths from `/etc/os-release` or XDG
  environment variables are redacted

It does not return hostnames or personal filesystem paths.

### `apps.list`

Lists XDG `.desktop` application entries. The result includes stable desktop ids,
display names, generic names, comments, categories, terminal/no-display flags, and
whether the entry came from user or system application directories. Each app also
includes `launcherAvailable` and `launchAllowed`. `launcherAvailable` is true
only when the entry exposes a supported desktop launcher through `Exec=` or
`DBusActivatable=true`. `launchAllowed` is derived from the plugin's exact
`allowedAppIds` policy, launcher availability, and the entry trust state.
Terminal and `Hidden=true` or `NoDisplay=true` entries report
`launchAllowed: false`. User or otherwise untrusted launchers report
`launcherTrust: "fingerprint-required"` until their current `.desktop` file
matches an `allowedAppLaunchers` SHA-256 fingerprint. The list does not expose
the raw allowlist separately.
On non-Linux hosts the action returns `available: false`, an empty app list, and
`reason: "unsupported platform"` instead of scanning local app-like directories.
Display metadata is sanitized before it is returned, so token-shaped values and
personal filesystem paths in `.desktop` names, generic names, comments, or
categories are redacted.

The tool intentionally omits raw `Exec` commands. `apps.launch` uses the stable
desktop id from this inventory and does not accept command text. Launcher-less
entries remain visible when otherwise safe, but they are not launchable through
this tool. Entries whose derived desktop id does not match the safe `.desktop` id
pattern, or whose delimited id contains sensitive-looking segments such as
token/secret/password labels, are skipped so malformed local filenames cannot
become tool-call targets or leak sensitive-looking strings.
Oversized `.desktop` files are skipped before parsing, and the returned
diagnostic is bounded and sanitized; `apps.launch` treats such entries as absent.

Optional parameters:

- `maxResults`
  - integer only, capped by plugin policy `maxApps`; requests can lower the
    returned count but cannot exceed the configured policy cap.
  - also caps returned parse diagnostics. The response includes `errorCount` and
    `errorsTruncated` so callers can see that diagnostics were omitted without
    returning an unbounded error list.
- `includeHidden`: can opt out of hidden app inventory when
  `includeNoDisplayApps` is enabled in plugin policy. It cannot opt in by itself;
  hidden and `NoDisplay` entries require plugin policy opt-in.

### `apps.launch`

Launches an exact allowlisted XDG desktop entry id using the platform launcher:

```json
{ "action": "apps.launch", "appId": "spotify.desktop" }
```

Security behavior:

- `allowedAppIds` must include the exact `appId`.
- User or otherwise untrusted launchers must also match an
  `allowedAppLaunchers` entry with the same id and the current `.desktop` file's
  SHA-256 hash. This prevents a user-writable desktop entry from shadowing an
  approved app id.
- Config validation accepts only XDG desktop ids shaped like
  `spotify.desktop` or `com.mitchellh.ghostty.desktop`.
- The desktop entry must exist in the XDG app inventory.
- The desktop entry must expose `Exec=` or `DBusActivatable=true`; launcher-less
  entries return `LINUX_DESKTOP_APP_LAUNCHER_UNSUPPORTED` before any host command
  is attempted.
- Exact launch lookup scans XDG app directories directly and is not capped by the
  bounded `apps.list` response used for display or validation.
- Terminal desktop entries are not launchable through `linux_desktop`; they remain
  visible in inventory with `terminal: true` and `launchAllowed: false`.
- `NoDisplay=true` desktop entries are not launchable through `linux_desktop`;
  they remain masked even if their id appears in `allowedAppIds`.
- `Hidden=true` desktop entries are not launchable through `linux_desktop`; they
  remain masked even if their id appears in `allowedAppIds`.
- The tool starts `gio launch <desktop-entry-file>` with no shell and no raw
  `Exec` exposure.
- Denials and launch failures use structured error codes such as
  `LINUX_DESKTOP_APP_NOT_ALLOWED`, `LINUX_DESKTOP_APP_TERMINAL_UNSUPPORTED`,
  `LINUX_DESKTOP_APP_HIDDEN_UNSUPPORTED`,
  `LINUX_DESKTOP_APP_NO_DISPLAY_UNSUPPORTED`,
  `LINUX_DESKTOP_APP_LAUNCHER_FINGERPRINT_REQUIRED`, and
  `LINUX_DESKTOP_APP_LAUNCH_FAILED`.

### `devices.usb`

Returns read-only USB device inventory from Linux sysfs. The result includes bus
number, device number, vendor id, product id, manufacturer, product name, speed,
class, and driver when available.

On non-Linux hosts the action returns `available: false`, an empty device list,
and `reason: "unsupported platform"` while still reporting `readOnly: true` and
serial-number omission.

USB serial numbers are not returned. The result only reports `serialPresent`.
Vendor/product ids, bus/device numbers, speed, and class values are normalized to
their expected sysfs shapes before they are returned. Manufacturer, product, and
driver labels are sanitized so token-shaped values and personal filesystem paths
are redacted. When bus/device numbers are missing, sensitive-looking sysfs
basename fallback ids are replaced with `usb-device`. Symlinked sysfs entries are
followed only when their resolved target stays inside the configured sysfs root.

### `windows.list`

Lists visible X11 windows through `wmctrl -lpGx` when X11 compatibility is
explicitly enabled:

```json
{ "action": "windows.list" }
```

Security behavior:

- GNOME/Wayland returns `available: false` with reason `wayland unsupported`.
  The tool does not use compositor-specific private APIs and does not fall back
  to `wmctrl`, even when an Xwayland display is also present.
- `windows.enabled` and `windows.allowX11` must both be `true`; otherwise the
  action reports unavailable before calling `wmctrl`.
- Results omit hostnames.
- Window titles are omitted by default. Titles are returned only when both the
  request sets `includeTitles: true` and config sets `windows.includeTitles: true`.
- WM class values and optional titles are sanitized before returning; token-shaped
  values and personal filesystem paths are redacted.
- Windows with delimited sensitive-looking WM classes such as `token_secret` are
  omitted, and matching focus allowlist entries are ignored.
- The action returns stable X11 window ids, desktop index, process id when
  available, geometry, WM class, and `titlePresent`.

### `windows.focus`

Focuses a visible X11 window by id:

```json
{ "action": "windows.focus", "windowId": "0x03c00007" }
```

Security behavior:

- `windows.enabled` and `windows.allowX11` must both be `true`.
- The target window id must come from `windows.list`.
- `windows.allowedFocusClasses` must include the target WM class exactly,
  including case.
- The action uses `wmctrl -ia <windowId>` with fixed arguments and no shell.
- GNOME/Wayland fails with `LINUX_DESKTOP_WINDOWS_WAYLAND_UNSUPPORTED` until a
  safe compositor, portal, or owned-surface strategy is accepted.

### `media.status`

Lists MPRIS-compatible media players on the user session bus and reports playback
state when available. The response honors `maxResults` with a bounded default
and includes `count`, `total`, and `truncated` so callers can tell when more
players exist without forcing unbounded per-player probes.

The action uses `busctl --user` with fixed arguments. If the session bus or MPRIS
is unavailable, the result reports `available: false` instead of falling back to
shell parsing.

Returned service names are canonicalized to valid `org.mpris.MediaPlayer2.*`
players. Sensitive-looking player identifiers are omitted, and playback status
text is sanitized before it is returned. Each listed player includes
`controlAllowed` and `controlActionCount` so the Gateway agent can see whether
the player is controllable under current policy without exposing the raw media
allowlists.

### `media.control`

Controls an allowlisted MPRIS player with an allowlisted transport action:

```json
{ "action": "media.control", "player": "spotify", "mediaAction": "playPause" }
```

Supported `mediaAction` values:

- `play`
- `pause`
- `playPause`
- `next`
- `previous`
- `stop`

Security behavior:

- `allowedMediaPlayers` must include the target player id, such as `spotify`, or
  the full service name, such as `org.mpris.MediaPlayer2.spotify`.
- `allowedMediaActions` must include the requested action.
- A user session bus must be present before any `busctl` command is attempted.
- Config validation rejects media player allowlist entries that are not valid
  MPRIS player ids.
- The tool calls MPRIS through `busctl --user call` with fixed arguments.
- It does not expose native player search, playlists, files, or arbitrary shell.

### `screen.capture`

Requests a screenshot through `xdg-desktop-portal` and waits for the portal
response:

```json
{ "action": "screen.capture", "screenTarget": "window" }
```

Supported `screenTarget` values:

- `screen`
- `window`
- `area`
- `activeWindow`

Security behavior:

- `screenCapture.enabled` must be `true`; plugin/tool allowlisting alone is not
  enough.
- The action requires a Linux user session bus and the desktop portal service.
- The portal request is always interactive, so the desktop environment shows its
  consent/selection UI.
- Successful captures include explicit non-sensitive consent metadata:
  `required: true`, `mode: "xdg-desktop-portal-interactive"`, and
  `granted: true`.
- Portal responses must report `response: 0` and include an artifact URI before
  `linux_desktop` copies or returns any screenshot artifact.
- Portal artifacts must be valid PNG images before they are copied into
  OpenClaw-managed output.
- Portal artifact URIs must not reference symlinks.
- The original portal file URI is redacted from the tool result because it may
  include personal filesystem paths.
- The screenshot is copied into an `output/` artifact path. `screenCapture.outputDir`
  must be relative, use safe path segments, and stay under `output/`.
- Portal screenshot PNG artifacts must stay under the bounded screen artifact
  byte limit before they are copied into `output/`.
- The `output/` artifact path is rooted under the Gateway/plugin workspace
  directory, not the shell directory that happened to start the Gateway process.
- Malformed runtime `screenCapture.outputDir` values are rejected before any portal
  capture is attempted.
- `screenCapture.timeoutMs` is integer-only, must be between 1 and 300000, and
  malformed runtime values are rejected before any portal capture is attempted.
- Existing `output/` path components must not be symlinks.
- Screenshot artifact and manifest creation use exclusive writes; existing files
  are not overwritten. If a capture already exists for the same target and
  second, `linux_desktop` allocates a numeric suffix such as `-1` instead of
  failing on a same-second filename collision.
- Each copied screenshot gets a sidecar capture manifest next to the PNG. The
  manifest records non-sensitive provenance such as target, byte count, capture
  time, the interactive portal provider, and the consent mode.
- The action captures pixels only. It does not OCR, summarize, or inspect native
  app contents.

### `screen.read`

Attaches a captured screen artifact to the tool result as an image content block,
using the same OpenClaw tool-result image handling as browser screenshots:

```json
{
  "action": "screen.read",
  "artifactPath": "output/linux-desktop-captures/linux-desktop-window-2026-05-31T21-30-00Z.png"
}
```

If `artifactPath` is omitted, `screen.read` can perform a new consented portal
capture first, but only when both `screenRead.allowCapture` and
`screenCapture.enabled` are `true`:

```json
{ "action": "screen.read", "screenTarget": "area" }
```

Security behavior:

- `screen.read` requires a Linux host, matching the rest of the `linux_desktop`
  screen surface.
- `screenRead.enabled` must be `true`.
- Existing artifacts must be relative paths under `output/`.
- Existing artifact directory segments under `output/` must use the same safe
  segment shape as capture output directories.
- Existing artifact paths must be non-empty. Supplying `artifactPath` disables
  live capture, so `screenTarget` is valid only when `artifactPath` is omitted.
- Existing artifact paths and sidecar manifest paths must not contain symlinks.
- Sidecar manifests must be regular files and are size-bounded before JSON
  parsing.
- Existing artifacts must use the `linux-desktop-<target>-<timestamp>.png`
  filename shape produced by `screen.capture`; `screen.read` is not a generic
  image-file reader.
- Existing artifacts must stay under the bounded screen artifact byte limit
  before `screen.read` base64-encodes and attaches them to a tool result.
- Existing artifacts must have a valid PNG signature before they are attached as
  image tool-result content.
- Existing artifacts must have a matching `linux_desktop` capture manifest with
  explicit portal consent metadata, so a caller cannot attach an arbitrary PNG or
  a legacy non-consent capture by only matching the filename pattern.
- Existing artifact paths are resolved relative to the Gateway/plugin workspace
  root and returned without leaking absolute workspace paths.
- The sidecar manifest target and capture timestamp must match the artifact
  filename, so a stale or hand-written manifest cannot be reused for a different
  screen artifact.
- Live capture uses the same interactive `xdg-desktop-portal` path as
  `screen.capture`.
- `screen.read` includes the verified capture provenance and consent metadata in
  the tool-result details before attaching the image for Gateway/model inspection.
- The result includes `SCREEN:<artifact>` text plus an image block for the Gateway
  agent/model to inspect.
- Artifact read/attachment failures return structured errors such as
  `LINUX_DESKTOP_SCREEN_ARTIFACT_NOT_FOUND` or
  `LINUX_DESKTOP_SCREEN_READ_ARTIFACT_FAILED` with redacted details.
- `linux_desktop` does not call providers, manage auth, or run OCR itself.

Each successful action writes a compact plugin audit log with the action name and
non-sensitive result metadata such as count, total, truncation state, availability,
or supported status. Inventory audit logs do not include raw app names, USB device
labels, window titles, hostnames, or media allowlists.
Screen capture/read audit logs include only the target, whether `screen.read`
performed a live capture, the consent mode, the `output/` artifact path, and byte
count; they do not include the original portal URI or host filesystem path.
Structured error details are redacted before they cross the Gateway tool boundary,
including provider tokens, API keys, cloud access keys, credential file paths, and
personal filesystem paths. Email-shaped identifiers in desktop metadata or
diagnostics are also redacted.

## Config

Optional plugin config:

```json
{
  "plugins": {
    "entries": {
      "linux-desktop": {
        "enabled": true,
        "config": {
          "actions": {
            "status": true,
            "appsList": true,
            "appsLaunch": true,
            "devicesUsb": true,
            "windowsList": true,
            "windowsFocus": true,
            "mediaStatus": true,
            "mediaControl": true,
            "screenCapture": true,
            "screenRead": true
          },
          "maxApps": 200,
          "includeNoDisplayApps": false,
          "allowedAppIds": ["spotify.desktop", "com.mitchellh.ghostty.desktop"],
          "allowedAppLaunchers": [
            {
              "id": "com.mitchellh.ghostty.desktop",
              "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            }
          ],
          "allowedMediaPlayers": ["spotify"],
          "allowedMediaActions": ["playPause", "pause", "next", "previous"],
          "windows": {
            "enabled": true,
            "allowX11": false,
            "includeTitles": false,
            "allowedFocusClasses": ["spotify.Spotify", "com.mitchellh.ghostty"]
          },
          "screenCapture": {
            "enabled": true,
            "outputDir": "output/linux-desktop-captures",
            "timeoutMs": 120000
          },
          "screenRead": {
            "enabled": true,
            "allowCapture": true
          }
        }
      }
    }
  }
}
```

Set an action to `false` to disable it even when the tool is allowlisted.
Allowlist arrays are validated by the plugin manifest before runtime and filtered
again at runtime: app ids and window focus classes are unique and capped at 200
entries, media players are unique and capped at 100 entries, and media actions
are unique and capped to the supported action set.

## Security Boundary

The current implementation does not:

- inspect native app contents inside the plugin
- expose USB serial numbers
- expose arbitrary shell execution

Native app launch, X11 window focus, and media control are available only through
explicit allowlists. Generic Wayland window focus remains unsupported until
OpenClaw has an accepted safe compositor or portal strategy. Screen capture is
available only through explicit opt-in plus the interactive desktop portal. Screen
read is available only through explicit opt-in and returns an image tool-result
block for Gateway/model inspection through normal OpenClaw auth and policy, not
plugin-owned OCR or provider calls. Future Wayland window actions must be opt-in,
allowlisted, consented where needed, documented, audited, tested, and aligned with
[Linux Gateway Desktop Voice Architecture](/experiments/plans/linux-gateway-desktop-voice).

## Validation

Source audit:

```bash
npm run audit
```

Installed Gateway read-only proof:

```bash
openclaw gateway call tools.invoke --json \
  --params '{"name":"linux_desktop","args":{"action":"status"}}'

openclaw gateway call tools.invoke --json \
  --params '{"name":"linux_desktop","args":{"action":"apps.list","maxResults":5}}'

openclaw gateway call tools.invoke --json \
  --params '{"name":"linux_desktop","args":{"action":"devices.usb","maxResults":5}}'
```

Before merging Linux desktop behavior changes, also run:

```bash
npm run build
npm run check
npm audit
npm test
npm pack --dry-run
```
