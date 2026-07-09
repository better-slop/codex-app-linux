import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("repo package manifest matches publisher toolchain", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(__dirname, "..", "package.json"), "utf8")
  );

  assert.equal(manifest.name, "codex-app-linux-publisher");
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.scripts.test, "npm run test:node && npm run test:host");
  assert.equal(manifest.scripts["test:node"], "node --test");
  assert.equal(
    manifest.scripts["test:host"],
    "cargo test --locked --manifest-path native/chrome-extension-host/Cargo.toml"
  );
  assert.equal(manifest.scripts["release:prod"], "node scripts/release-channel.mjs --channel prod");
  assert.equal(manifest.scripts["release:beta"], "node scripts/release-channel.mjs --channel beta");
  assert.equal(manifest.devDependencies.electron, "42.1.0");
  assert.equal(manifest.devDependencies["electron-builder"], "26.8.1");
});
