import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("electron-builder preserves the upstream package entry point", async () => {
  const config = await fs.readFile(
    path.join(__dirname, "..", "electron-builder.config.mjs"),
    "utf8"
  );

  assert.doesNotMatch(config, /extraMetadata\s*:\s*\{\s*main\s*:/);
});
