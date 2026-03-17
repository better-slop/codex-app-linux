import test from "node:test";
import assert from "node:assert/strict";

import { parseAppcastXml } from "../scripts/lib/appcast.mjs";
import { npmVersionFor } from "../scripts/lib/config.mjs";

test("parseAppcastXml reads the latest enclosure", () => {
  const xml = `<?xml version="1.0" standalone="yes"?>
<rss version="2.0">
  <channel>
    <item>
      <title>26.313.41514</title>
      <pubDate>Tue, 17 Mar 2026 00:14:56 +0000</pubDate>
      <sparkle:version>1041</sparkle:version>
      <sparkle:shortVersionString>26.313.41514</sparkle:shortVersionString>
      <enclosure url="https://persistent.oaistatic.com/codex-app-beta/Codex%20(Beta)-darwin-arm64-26.313.41514.zip" length="172607285" />
    </item>
  </channel>
</rss>`;

  assert.deepEqual(parseAppcastXml(xml), {
    title: "26.313.41514",
    pubDate: "Tue, 17 Mar 2026 00:14:56 +0000",
    version: "26.313.41514",
    buildNumber: "1041",
    archiveUrl:
      "https://persistent.oaistatic.com/codex-app-beta/Codex%20(Beta)-darwin-arm64-26.313.41514.zip",
    archiveLength: "172607285"
  });
});

test("npmVersionFor keeps prod clean and beta prerelease-tagged", () => {
  const upstream = {
    version: "26.313.41514",
    buildNumber: "1041"
  };

  assert.equal(npmVersionFor("prod", upstream), "26.313.41514");
  assert.equal(npmVersionFor("beta", upstream), "26.313.41514-beta.1041");
});
