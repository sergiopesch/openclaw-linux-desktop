# Changelog

## 0.1.0 - 2026-06-07

- Package Linux Desktop as an external OpenClaw plugin for ClawHub publication.
- Add the optional `linux_desktop` tool for Linux desktop status, app inventory, allowlisted app launch, USB inventory, X11 window inventory/focus, MPRIS media status/control, portal screen capture, and screen artifact reading.
- Keep generic Wayland native window inventory/focus fail-closed and expose `status.windowBackends` with safe alternatives.
- Add source audit coverage for fail-closed Wayland behavior, backend path hijack protection, redaction, and screen artifact reading.
