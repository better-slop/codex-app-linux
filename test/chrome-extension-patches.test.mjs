import test from "node:test";
import assert from "node:assert/strict";

import {
  hasLinuxChromeExtensionHostContentVariant,
  linuxChromeExtensionHostContentVariantContract,
  patchLinuxChromeExtensionHostContentVariant
} from "../scripts/lib/chrome-extension-patches.mjs";
import { applyUpstreamPatchContract } from "../scripts/lib/upstream-patches.mjs";

const upstreamMaterializer = [
  "async function Za(e){",
  "let t,n=[],r=qa.get(e.pluginName);",
  "if(r==null?e.pluginName===`computer-use`&&(t=e.computerUseSkillVariant):(t=e.browserSkillVariant),t==null)return;",
  "let i=join(e.pluginRoot,`.codex-plugin`,`plugin.json`),a=await schema.parseAsync(JSON.parse(await fs.readFile(i,`utf8`)));",
  "await fs.writeFile(i,`${JSON.stringify({...a,bundledContentVariant:t},null,2)}\\n`,`utf8`)",
  "}"
].join("");

test("patchLinuxChromeExtensionHostContentVariant revises only the Chrome cache identity", () => {
  const patched = patchLinuxChromeExtensionHostContentVariant(upstreamMaterializer);

  assert.match(
    patched,
    /bundledContentVariant:e\.pluginName===`chrome`\?`\$\{t\}-linux-extension-host-v3`:t/
  );
  assert.equal(hasLinuxChromeExtensionHostContentVariant(patched), true);
});

test("patchLinuxChromeExtensionHostContentVariant is idempotent", () => {
  const patched = patchLinuxChromeExtensionHostContentVariant(upstreamMaterializer);

  assert.equal(patchLinuxChromeExtensionHostContentVariant(patched), patched);
});

test("content-variant contract runner accepts an already patched bundle", () => {
  const patched = applyUpstreamPatchContract(
    upstreamMaterializer,
    linuxChromeExtensionHostContentVariantContract
  );

  assert.equal(
    applyUpstreamPatchContract(patched, linuxChromeExtensionHostContentVariantContract),
    patched
  );
});

test("patchLinuxChromeExtensionHostContentVariant fails on upstream contract drift", () => {
  assert.throws(
    () => patchLinuxChromeExtensionHostContentVariant("async function unrelated(){}"),
    /Chrome plugin content-variant contract changed/
  );
});
