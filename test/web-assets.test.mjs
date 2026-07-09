import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildPatchedIndexHtml,
  defaultAllowedLocalAssetRoots,
  findAppHostRpcModulePath,
  patchStatsigChunkSource,
  readAllowedLocalAssetFile,
  readBuildMetadata,
  readExtractedBuildMetadata,
  resolveCodexAppPaths
} from "../runtime/webstrap/assets.mjs";
import { createAppHostModuleBody } from "../runtime/webstrap/server.mjs";
import { safePathJoin } from "../runtime/webstrap/util.mjs";

test("resolveCodexAppPaths supports linux-unpacked layout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-web-assets-"));
  const appRoot = path.join(root, "linux-unpacked");
  const resourcesPath = path.join(appRoot, "resources");

  await fs.mkdir(resourcesPath, { recursive: true });
  await fs.writeFile(path.join(resourcesPath, "app.asar"), "");
  await fs.writeFile(path.join(resourcesPath, "codex"), "", { mode: 0o755 });

  const resolved = resolveCodexAppPaths(appRoot);

  assert.equal(resolved.appPath, appRoot);
  assert.equal(resolved.resourcesPath, resourcesPath);
  assert.equal(resolved.asarPath, path.join(resourcesPath, "app.asar"));
  assert.equal(resolved.codexCliPath, path.join(resourcesPath, "codex"));
});

test("readBuildMetadata supports linux package metadata without Info.plist", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-web-build-"));
  const appRoot = path.join(root, "linux-unpacked");
  const resourcesPath = path.join(appRoot, "resources");

  await fs.mkdir(resourcesPath, { recursive: true });
  await fs.writeFile(path.join(resourcesPath, "app.asar"), "");
  await fs.writeFile(
    path.join(resourcesPath, "app-package.json"),
    JSON.stringify({
      version: "26.313.41514",
      codexBuildNumber: "41514",
      codexBuildFlavor: "public-beta"
    })
  );

  const metadata = await readBuildMetadata({
    appPath: appRoot,
    resourcesPath,
    asarPath: path.join(resourcesPath, "app.asar"),
    packageMetadataPath: path.join(resourcesPath, "app-package.json")
  });

  assert.equal(metadata.shortVersion, "26.313.41514");
  assert.equal(metadata.bundleVersion, "41514");
  assert.equal(metadata.buildNumber, "41514");
  assert.equal(metadata.buildFlavor, "public-beta");
  assert.match(metadata.buildKey, /26\.313\.41514/);
});

test("readExtractedBuildMetadata reads version from extracted asar package", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-web-extract-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      version: "26.325.21211",
      codexBuildNumber: "1251",
      codexBuildFlavor: "public-beta"
    })
  );

  const metadata = await readExtractedBuildMetadata(root, {
    shortVersion: "unknown",
    buildNumber: "unknown",
    buildFlavor: "prod"
  });

  assert.equal(metadata.shortVersion, "26.325.21211");
  assert.equal(metadata.buildNumber, "1251");
  assert.equal(metadata.buildFlavor, "public-beta");
  assert.match(metadata.buildKey, /26\.325\.21211-1251/);
});

test("buildPatchedIndexHtml installs web app host before upstream app entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-web-html-"));
  const indexPath = path.join(root, "index.html");

  await fs.writeFile(
    indexPath,
    [
      "<html>",
      "<head>",
      '<script type="module" crossorigin src="./assets/index-abc.js"></script>',
      "</head>",
      "<body></body>",
      "</html>"
    ].join("\n")
  );

  const patched = await buildPatchedIndexHtml(indexPath);

  assert.match(patched, /<script type="module" src="\/__webstrapper\/app-host\.js"><\/script>\s*<script type="module" crossorigin src="\.\/assets\/index-abc\.js"><\/script>/);
  assert.match(patched, /<script src="\/__webstrapper\/shim\.js"><\/script>/);
});

test("createAppHostModuleBody resolves RPC peer constructor semantically", () => {
  const body = createAppHostModuleBody(
    "/tmp/codex-web/webview/assets/rpc-new.js",
    "/tmp/codex-web/webview"
  );

  assert.match(body, /const rpcModulePromise = import/);
  assert.match(body, /const functionToString = Function\.prototype\.toString;\s+const rpcModulePromise = import/);
  assert.match(body, /\[rpcModule\.tC, rpcModule\.V, rpcModule\.E, \.\.\.Object\.values\(rpcModule\)\]\.find/);
  assert.match(body, /functionToString\.call\(value\)\.includes\("getRemoteMain"\)/);
  assert.doesNotMatch(body, /Function\.prototype\.toString\.call\(value\)/);
  assert.doesNotMatch(body, /import \{ E as createRpcPeer \}/);
});

test("findAppHostRpcModulePath accepts upstream rpc facade layout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-rpc-assets-"));
  const assetsDir = path.join(root, "assets");
  await fs.mkdir(assetsDir);
  await fs.writeFile(
    path.join(assetsDir, "rpc-new.js"),
    "import{bS as e,vS as t,xS as n,yS as r}from './app-initial.js';e();export{t as appHost,r as appServices,n as initializeAppHostServices};"
  );
  const appInitialPath = path.join(assetsDir, "app-initial.js");
  await fs.writeFile(
    appInitialPath,
    [
      "function peer(port,target){return new Rpc(port,target).getRemoteMain()}",
      "function connect(){window.postMessage({type:`connect-app-host`},window.location.origin)}",
      "const services={appUpdates:{stateChanged(){}}}",
      "export{peer as tC}"
    ].join(";")
  );

  assert.equal(await findAppHostRpcModulePath(assetsDir), appInitialPath);
});

test("patchStatsigChunkSource makes statsig init non-blocking", () => {
  const source =
    "function i(e,n){let i=(0,t.useMemo)(()=>(0,r._getInstance)(n.sdkKey)??e(n),[]),[a,o]=(0,t.useState)(i.loadingStatus!==`Ready`);return(0,t.useMemo)(()=>{i.loadingStatus!==`Ready`&&i.initializeAsync().catch(r.Log.error).finally(()=>o(!1))},[]),{client:i,isLoading:a}}";

  const patched = patchStatsigChunkSource(source);

  assert.match(patched, /\[a,o\]=\(0,t\.useState\)\(!1\)/);
  assert.doesNotMatch(patched, /i\.loadingStatus!==`Ready`\);return/);
});

test("readAllowedLocalAssetFile serves plugin assets from approved roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-local-assets-"));
  const assetPath = path.join(root, "plugins", "github", "assets", "github.png");

  await fs.mkdir(path.dirname(assetPath), { recursive: true });
  await fs.writeFile(assetPath, "png-data");

  const result = await readAllowedLocalAssetFile(assetPath, [root]);

  assert.equal(result?.contentType, "image/png");
  assert.equal(result?.body.toString("utf8"), "png-data");
});

test("readAllowedLocalAssetFile rejects paths outside approved roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-local-assets-"));
  const outsideRoot = `${root}-sibling`;
  const assetPath = path.join(outsideRoot, "plugins", "github", "assets", "github.png");

  await fs.mkdir(path.dirname(assetPath), { recursive: true });
  await fs.writeFile(assetPath, "png-data");

  const result = await readAllowedLocalAssetFile(assetPath, [root]);

  assert.equal(result, null);
});

test("safePathJoin rejects sibling prefix escapes", () => {
  const joined = safePathJoin("/tmp/codex-root", "../codex-root-sibling/secret.txt");
  assert.equal(joined, null);
});

test("defaultAllowedLocalAssetRoots points at codex plugin temp assets", () => {
  assert.deepEqual(defaultAllowedLocalAssetRoots("/home/tester"), [
    "/home/tester/.codex/.tmp/plugins"
  ]);
});
