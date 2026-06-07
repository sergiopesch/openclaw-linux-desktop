#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function assertFile(relativePath) {
  assert.equal(fs.existsSync(path.join(root, relativePath)), true, `${relativePath} is missing`);
}

function main() {
  const pkg = readJson("package.json");
  const manifest = readJson("openclaw.plugin.json");

  assert.equal(pkg.name, "@sergiopesch/linux-desktop");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.openclaw.compat.pluginApi, ">=2026.6.1");
  assert.equal(pkg.openclaw.compat.minGatewayVersion, "2026.6.1");
  assert.deepEqual(pkg.openclaw.extensions, ["./index.ts"]);
  assert.deepEqual(pkg.openclaw.runtimeExtensions, ["./dist/index.js"]);
  assert.equal(pkg.peerDependencies.openclaw, ">=2026.6.1");
  assert.equal(pkg.peerDependenciesMeta.openclaw.optional, true);
  assert.equal(pkg.devDependencies.openclaw, undefined);

  assert.equal(manifest.id, "linux-desktop");
  assert.equal(manifest.name, "Linux Desktop");
  assert.deepEqual(manifest.contracts.tools, ["linux_desktop"]);
  assert.equal(manifest.toolMetadata.linux_desktop.optional, true);
  assert.equal(manifest.activation.onStartup, true);
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.equal(manifest.configSchema.properties.allowedAppLaunchers.type, "array");
  assert.equal(
    manifest.configSchema.properties.allowedAppLaunchers.items.properties.sha256.pattern,
    "^[a-f0-9]{64}$",
  );

  for (const file of [
    "README.md",
    "DOCS.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "SECURITY.md",
    ".npmrc",
    "types/openclaw-plugin-entry.d.ts",
    "index.ts",
    "src/linux-desktop-tool.ts",
    "scripts/audit-plugin.mjs",
  ]) {
    assertFile(file);
  }

  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /clawhub:@sergiopesch\/linux-desktop/);
  assert.match(readme, /unsupported-generic-window-control/);
  assert.doesNotMatch(readme, /Bundled optional plugin/);

  const source = fs.readFileSync(path.join(root, "src/linux-desktop-tool.ts"), "utf8");
  assert.match(source, /WAYLAND_WINDOW_STRATEGY = "unsupported-generic-window-control"/);
  assert.doesNotMatch(source, /from "openclaw\/plugin-sdk";/);

  console.log("Plugin metadata validation passed.");
}

main();
