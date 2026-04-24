import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { UdsIpcClient } from "../runtime/webstrap/ipc-uds.mjs";

test("UdsIpcClient.start resolves when the socket is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-uds-"));
  const client = new UdsIpcClient({
    socketPath: path.join(root, "missing.sock"),
    reconnectMs: 60_000,
    logger: {
      info() {},
      debug() {},
      warn() {},
      error() {}
    }
  });

  await assert.doesNotReject(client.start());
  assert.equal(client.isReady(), false);
  client.stop();
});
