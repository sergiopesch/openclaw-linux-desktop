# Contributing

Linux Desktop is a local-system-control OpenClaw plugin. Contributions should
improve safety, reliability, and operator clarity before adding new reach.

## Standards

- Keep app launch, media control, window focus, screen capture, and screen read
  behind explicit config gates.
- Do not add generic Wayland window inventory or focus through private compositor
  internals.
- Prefer portal, browser, node, or owned-surface strategies for Wayland evidence.
- Do not expose raw desktop entry `Exec` commands, USB serial numbers, portal
  URIs, provider credentials, or personal filesystem paths.
- Keep helper command execution fixed-argument and shell-free.
- Resolve backend helpers from trusted system locations, not user-writable paths.

## Validation

Run the full local check before publishing or submitting changes:

```bash
npm run build
npm run check
npm audit
npm test
npm pack --dry-run
```

`npm test` validates plugin metadata and runs the focused source audit.

Do not add `openclaw` as a dev dependency only to satisfy TypeScript. The host
runtime provides the SDK; local builds should use the focused declaration file
under `types/` unless the plugin starts using additional SDK surface.
