import test from "node:test";
import assert from "node:assert/strict";

test("electron-builder preserves the upstream package entry point", async () => {
  const previous = {
    CODEX_ELECTRON_VERSION: process.env.CODEX_ELECTRON_VERSION,
    CODEX_OUTPUT_DIR: process.env.CODEX_OUTPUT_DIR,
    CODEX_STAGE_APP_DIR: process.env.CODEX_STAGE_APP_DIR
  };
  process.env.CODEX_ELECTRON_VERSION = "42.1.0";
  process.env.CODEX_OUTPUT_DIR = "/tmp/codex-output";
  process.env.CODEX_STAGE_APP_DIR = "/tmp/codex-stage";
  try {
    const config = (
      await import(`../electron-builder.config.mjs?entry-test=${Date.now()}`)
    ).default;
    assert.equal(config.extraMetadata, undefined);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
