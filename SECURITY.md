# Security

This plugin exposes host desktop capabilities to OpenClaw when explicitly enabled
and allowlisted. Treat installation as granting local-system-control capability.

## Security Model

- The `linux_desktop` tool is optional and should be allowlisted only for trusted
  agents.
- App launch, media control, window focus, screen capture, and screen read require
  explicit plugin config gates.
- App launch uses exact desktop-entry allowlists and does not expose raw `Exec`
  commands. User or otherwise untrusted desktop entries also require a pinned
  SHA-256 fingerprint through `allowedAppLaunchers`.
- X11 window focus requires exact WM class allowlists.
- Generic Wayland native window inventory/focus is unsupported.
- Screen capture uses the interactive desktop portal consent flow.
- Screen read attaches capture artifacts for model inspection; the plugin does
  not call providers or perform OCR itself.

## Reporting Issues

Report security issues privately to Sergio Pesch or through the repository issue
process with enough detail to reproduce the behavior. Do not include real tokens,
provider credentials, private screenshots, or personal filesystem paths in public
reports.
