# OpenClaw Linux Desktop

Linux Desktop is an external OpenClaw plugin that adds the optional
`linux_desktop` agent tool for Linux laptop and workstation evidence workflows.

It is designed for agents that need to inspect the local desktop environment,
launch exact allowlisted apps, attach consented screenshots, or prove visible
work without using unsafe Wayland compositor internals.

## Capabilities

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

The surface is narrow and policy-gated. The plugin does not inspect app
contents, expose USB serial numbers, provide arbitrary shell execution, call
model providers, or perform OCR itself.

## Install

During local development:

```bash
cd ~/openclaw-linux-desktop
npm install
npm run build
openclaw plugins install --link .
openclaw gateway restart
```

The package declares `openclaw` as an optional npm peer because the OpenClaw
host supplies the runtime SDK when it loads the plugin. Local TypeScript builds
use the narrow declaration in `types/openclaw-plugin-entry.d.ts`, which keeps
development installs small and avoids bundling OpenClaw's dependency tree.

After ClawHub publication:

```bash
openclaw plugins install clawhub:@sergiopesch/linux-desktop
openclaw gateway restart
```

Enable the plugin and allow the optional tool:

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

If your config already uses `tools.allow`, add `linux_desktop` to that allowlist
instead of adding `tools.alsoAllow`.

## Configuration

After the plugin and tool are enabled, the read-only actions `status`,
`apps.list`, and `devices.usb` default on when omitted. App launch, windows,
media, screen capture, and screen read default off and require their matching
`actions.*` gate to be explicitly `true`.

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
          "allowedAppIds": ["dev.limux.linux.desktop"],
          "allowedAppLaunchers": [
            {
              "id": "dev.limux.linux.desktop",
              "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            }
          ],
          "allowedMediaPlayers": ["spotify"],
          "allowedMediaActions": ["playPause", "pause", "next", "previous"],
          "windows": {
            "enabled": true,
            "allowX11": false,
            "includeTitles": false,
            "allowedFocusClasses": ["dev.limux.linux"]
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

## Wayland Policy

Generic native Wayland window inventory and focus are intentionally unsupported.
Wayland does not expose a safe generic public API for listing or focusing
arbitrary application windows.

On GNOME/Wayland, `windows.list` returns `available: false` with
`reason: "wayland unsupported"`, and `windows.focus` fails with
`LINUX_DESKTOP_WINDOWS_WAYLAND_UNSUPPORTED`.

The `status` action exposes `windowBackends.wayland.strategy` as
`unsupported-generic-window-control` so agents can choose safe alternatives:

- `screen.capture`
- `screen.read`
- `browser`
- `nodes`
- owned-surface protocols such as Limux

Future Wayland window actions must use an accepted safe compositor, portal, or
owned-surface strategy before being enabled.

## Security Notes

- Desktop app listing reads XDG `.desktop` entries and omits raw `Exec` commands.
- App launch uses `gio launch <desktop-entry-file>` with no shell. Root-owned
  system launchers require exact `allowedAppIds`; user or otherwise untrusted
  launchers also require an `allowedAppLaunchers` SHA-256 fingerprint match.
- USB inventory reads sysfs and reports only non-secret device metadata.
- X11 window focus uses `wmctrl -ia <windowId>` only after exact WM class
  allowlist approval.
- Media status/control uses MPRIS over `busctl --user`; control requires exact
  player and action allowlists.
- Screen capture uses `xdg-desktop-portal` and returns only an `output/`
  artifact path.
- Screen read attaches an `output/` artifact to the tool result as an image
  block for normal OpenClaw model inspection.
- Host commands and portal helpers receive only allowlisted desktop/session
  runtime environment variables.
- Backend helpers are resolved from trusted root-owned system locations instead
  of user-writable `PATH` entries.

## Validation

```bash
npm run build
npm run check
npm audit
npm test
npm pack --dry-run
```

Live Gateway proof:

```bash
openclaw gateway call tools.invoke --json \
  --params '{"name":"linux_desktop","args":{"action":"status"}}'

openclaw gateway call tools.invoke --json \
  --params '{"name":"linux_desktop","args":{"action":"windows.list","maxResults":5}}'
```

## Publish

The package name is scoped to the ClawHub owner:

```text
@sergiopesch/linux-desktop
```

This repository is prepared for ClawHub plugin submission once the active
ClawHub plugin publishing workflow is available. The local `clawhub` CLI v0.7.0
installed on this machine currently exposes `clawhub publish <path>` for skill
folders, not a plugin-package publish command, so do not use that skill command
for this plugin package.
