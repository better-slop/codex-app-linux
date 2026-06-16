import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

import {
  assetBaseName,
  cacheRoot,
  channelPaths,
  defaultLauncherCommand,
  defaultPackageName,
  defaultReleaseRepo,
  npmVersionFor,
  projectRoot,
  releaseTagForVersion
} from "./config.mjs";
import { patchUpstreamApp } from "./upstream-patches.mjs";
import { writeAurPackage } from "./aur.mjs";

const skippedLinuxResourceNames = new Set([
  "app.asar",
  "app.asar.unpacked",
  "codex",
  "codex_chronicle",
  "cua_node",
  "native",
  "node",
  "node_repl",
  "rg"
]);
const skippedBundledPluginNames = new Set(["computer-use", "latex-tectonic"]);
const primaryRuntime = {
  url:
    process.env.CODEX_PRIMARY_RUNTIME_URL ||
    "https://persistent.oaistatic.com/codex-primary-runtime/26.426.12240/codex-primary-runtime-linux-x64-26.426.12240.tar.xz",
  sha256:
    process.env.CODEX_PRIMARY_RUNTIME_SHA256 ||
    "db5624eb6efa36b66ec6f6dd0488cefb966e49636862aab6209a4336c1ca90c4",
  nodeEntry: "codex-primary-runtime/dependencies/node/bin/node",
  nodeReplEntry: "codex-primary-runtime/dependencies/bin/node_repl"
};
const codexCliRuntime = {
  url:
    process.env.CODEX_CLI_RUNTIME_URL ||
    "https://github.com/openai/codex/releases/download/rust-v0.140.0/codex-package-x86_64-unknown-linux-musl.tar.gz",
  sha256:
    process.env.CODEX_CLI_RUNTIME_SHA256 ||
    "9620e798900c6fb289199a9e0a8ed0c3a8cb7e3561048498ebc2dac354a1627b",
  codexEntry: "bin/codex"
};

export async function buildChannel({
  channel,
  upstream,
  packageName = defaultPackageName,
  launcherCommand = defaultLauncherCommand,
  releaseRepo = defaultReleaseRepo,
  archiveOverride
}) {
  const paths = channelPaths(channel.name);
  const archivePath =
    archiveOverride || (await fetchArchive(upstream.archiveUrl, paths.cacheDir));

  await ensureEmptyDir(paths.stageDir);
  await ensureEmptyDir(paths.outputDir);
  await ensureEmptyDir(paths.npmDir);
  await ensureEmptyDir(paths.stageResourcesDir);
  await ensureDir(paths.stageArchiveDir);

  await extractArchive(archivePath, paths.stageArchiveDir);

  const appBundlePath = await findAppBundle(paths.stageArchiveDir);
  const appResourcesDir = path.join(appBundlePath, "Contents", "Resources");
  const appAsarPath = path.join(appResourcesDir, "app.asar");

  await run([
    "npx",
    "--no-install",
    "asar",
    "extract",
    appAsarPath,
    paths.stageAppDir
  ]);
  await patchUpstreamApp(paths.stageAppDir);
  await stagePackagedResources(appResourcesDir, paths.stageResourcesDir);
  await stageLinuxCodexCliRuntime(paths.stageResourcesDir);
  await stageLinuxNodeReplRuntime(paths.stageResourcesDir);

  const effectiveUpstream = await normalizeStagePackage(
    paths.stageAppDir,
    upstream,
    archiveOverride || null
  );
  await writeLinuxAppPackageMetadata(paths.stageResourcesDir, effectiveUpstream);
  const packageVersion = npmVersionFor(channel.name, effectiveUpstream);
  const releaseTag = releaseTagForVersion(packageVersion);
  const assetPrefix = assetBaseName(packageName, packageVersion);
  const linuxIconPath = await createLinuxIcon(paths.stageDir, paths.stageAppDir);

  await hydrateNativeModules(paths.stageDir, paths.stageAppDir, effectiveUpstream.electronVersion);
  await buildLinuxArtifacts({
    stageAppDir: paths.stageAppDir,
    stageResourcesDir: paths.stageResourcesDir,
    outputDir: paths.outputDir,
    electronVersion: effectiveUpstream.electronVersion,
    executableName: channel.executableName,
    productName: channel.displayName,
    desktopName: channel.displayName,
    appId: channel.appId,
    linuxIconPath
  });

  const linuxDir = path.join(paths.outputDir, "linux-unpacked");
  const appImagePath = await renameAppImage(paths.outputDir, `${assetPrefix}.AppImage`);
  const unpackedTarballPath = path.join(
    paths.outputDir,
    `${assetPrefix}-linux-unpacked.tar.gz`
  );
  const iconAssetPath = path.join(paths.outputDir, `${assetPrefix}.png`);

  await packDirectory(linuxDir, unpackedTarballPath);
  await fs.copyFile(linuxIconPath, iconAssetPath);

  const appImageSha256 = await sha256File(appImagePath);
  const unpackedTarballSha256 = await sha256File(unpackedTarballPath);
  const iconSha256 = await sha256File(iconAssetPath);
  const checksumsPath = path.join(paths.outputDir, `${assetPrefix}.sha256`);

  await fs.writeFile(
    checksumsPath,
    [
      `${appImageSha256}  ${path.basename(appImagePath)}`,
      `${unpackedTarballSha256}  ${path.basename(unpackedTarballPath)}`,
      `${iconSha256}  ${path.basename(iconAssetPath)}`
    ].join("\n") + "\n"
  );

  const aurDir = path.join(paths.outputDir, "aur");
  const aurPackage = await writeAurPackage({
    channel,
    packageVersion,
    releaseRepo,
    releaseTag,
    executableName: channel.executableName,
    tarballAssetName: path.basename(unpackedTarballPath),
    tarballSha256: unpackedTarballSha256,
    iconAssetName: path.basename(iconAssetPath),
    iconSha256,
    targetDir: aurDir
  });

  const packageDir = await assembleNpmPackage({
    channel,
    upstream: effectiveUpstream,
    packageName,
    packageVersion,
    launcherCommand,
    releaseRepo,
    releaseTag,
    executableName: channel.executableName,
    unpackedTarballAssetName: path.basename(unpackedTarballPath),
    unpackedTarballSha256,
    targetDir: paths.npmDir
  });

  return {
    archivePath,
    npmVersion: packageVersion,
    packageDir,
    linuxDir,
    appImagePath,
    unpackedTarballPath,
    iconAssetPath,
    checksumsPath,
    aurDir,
    aurPackage,
    releaseRepo,
    releaseTag
  };
}

export async function npmVersionExists(packageName, version) {
  try {
    const output = await run(
      ["npm", "view", `${packageName}@${version}`, "version", "--json"],
      { capture: true }
    );

    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export async function publishPackage(packageDir, distTag) {
  await run(["npm", "publish", packageDir, "--access", "public", "--tag", distTag]);
}

async function fetchArchive(url, cacheDir) {
  await ensureDir(cacheDir);

  const fileName = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
  const archivePath = path.join(cacheDir, fileName);
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await pipeline(response.body, createWriteStream(archivePath));

  return archivePath;
}

async function extractArchive(archivePath, targetDir) {
  if (archivePath.endsWith(".zip")) {
    await run(["bsdtar", "-xf", archivePath, "-C", targetDir]);
    return;
  }

  await run(["7z", "x", "-y", archivePath, `-o${targetDir}`]);
}

async function findAppBundle(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      return fullPath;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    const nested = await findAppBundle(fullPath).catch(() => null);

    if (nested) {
      return nested;
    }
  }

  throw new Error(`No .app bundle found under ${rootDir}`);
}

async function normalizeStagePackage(stageAppDir, upstream, archiveOverride) {
  const packageJsonPath = path.join(stageAppDir, "package.json");
  const original = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const normalized = {
    name: original.name,
    productName: original.productName,
    author: original.author,
    version: original.version,
    description: original.description,
    main: original.main,
    dependencies: {
      "better-sqlite3": original.dependencies["better-sqlite3"],
      "node-pty": original.dependencies["node-pty"],
      bindings: "^1.5.0",
      "file-uri-to-path": "^1.0.0",
      "node-addon-api": "^8.5.0",
      "prebuild-install": "^7.1.3",
      tslib: original.dependencies.tslib || "^2.8.1"
    },
    codexBuildFlavor: original.codexBuildFlavor,
    codexBuildNumber: original.codexBuildNumber,
    codexSparkleFeedUrl: original.codexSparkleFeedUrl
  };

  await fs.writeFile(packageJsonPath, `${JSON.stringify(normalized, null, 2)}\n`);

  return {
    ...upstream,
    archiveUrl: archiveOverride || upstream.archiveUrl,
    version: original.version,
    buildNumber: original.codexBuildNumber,
    buildFlavor: original.codexBuildFlavor,
    electronVersion: resolveElectronVersion(original)
  };
}

export async function writeLinuxAppPackageMetadata(targetDir, upstream) {
  await fs.writeFile(
    path.join(targetDir, "app-package.json"),
    `${JSON.stringify(
      {
        version: upstream.version,
        codexBuildNumber: upstream.buildNumber,
        codexBuildFlavor: upstream.buildFlavor
      },
      null,
      2
    )}\n`
  );
}

function resolveElectronVersion(packageJson) {
  const electronVersion = packageJson.devDependencies?.electron;

  if (typeof electronVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
    throw new Error("Upstream package.json must declare an exact devDependencies.electron version");
  }

  return electronVersion;
}

async function createLinuxIcon(stageDir, stageAppDir) {
  const iconDir = path.join(stageDir, "build-resources");
  const iconPath = path.join(iconDir, "icon.png");
  const webviewAssetsDir = path.join(stageAppDir, "webview", "assets");
  const assets = await fs.readdir(webviewAssetsDir);
  const appIcon = assets
    .filter(name => /^app-.*\.png$/i.test(name))
    .sort()
    .at(0);

  if (!appIcon) {
    throw new Error(`Unable to locate app icon under ${webviewAssetsDir}`);
  }

  await ensureDir(iconDir);
  await fs.copyFile(path.join(webviewAssetsDir, appIcon), iconPath);

  return iconPath;
}

async function hydrateNativeModules(stageDir, stageAppDir, electronVersion) {
  const nativeWorkspaceDir = path.join(stageDir, "native-workspace");
  const stagePackageJson = JSON.parse(
    await fs.readFile(path.join(stageAppDir, "package.json"), "utf8")
  );

  await ensureEmptyDir(nativeWorkspaceDir);
  await fs.writeFile(
    path.join(nativeWorkspaceDir, "package.json"),
    `${JSON.stringify(
      {
        name: "codex-app-linux-native-workspace",
        private: true,
        dependencies: {
          "better-sqlite3": stagePackageJson.dependencies["better-sqlite3"],
          "node-pty": stagePackageJson.dependencies["node-pty"],
          bindings: "^1.5.0",
          "file-uri-to-path": "^1.0.0",
          "node-addon-api": "^8.5.0",
          "prebuild-install": "^7.1.3",
          tslib: "^2.8.1"
        }
      },
      null,
      2
    )}\n`
  );

  await run(["npm", "install", "--no-package-lock"], { cwd: nativeWorkspaceDir });
  await patchBetterSqlite3NativeSource(
    path.join(nativeWorkspaceDir, "node_modules", "better-sqlite3")
  );
  await run(
    [
      "npx",
      "--no-install",
      "electron-rebuild",
      "--version",
      electronVersion,
      "--arch",
      "x64",
      "--module-dir",
      nativeWorkspaceDir,
      "--force",
      "--only",
      "better-sqlite3,node-pty"
    ],
    { cwd: nativeWorkspaceDir }
  );

  for (const dependency of [
    "better-sqlite3",
    "node-pty",
    "bindings",
    "file-uri-to-path",
    "node-addon-api",
    "prebuild-install",
    "tslib"
  ]) {
    const source = path.join(nativeWorkspaceDir, "node_modules", dependency);
    const target = path.join(stageAppDir, "node_modules", dependency);

    await fs.rm(target, { recursive: true, force: true });
    await copyRecursive(source, target);
  }

  await prunePlatformNativePrebuilds(stageAppDir);
}

export async function patchBetterSqlite3NativeSource(packageDir) {
  const macrosPath = path.join(packageDir, "src", "util", "macros.cpp");
  const helpersPath = path.join(packageDir, "src", "util", "helpers.cpp");
  const entrypointPath = path.join(packageDir, "src", "better_sqlite3.cpp");

  let macros = await fs.readFile(macrosPath, "utf8");
  macros = patchBetterSqlite3ExternalPointerMacros(macros);
  await fs.writeFile(macrosPath, macros);

  let entrypoint = await fs.readFile(entrypointPath, "utf8");
  entrypoint = patchBetterSqlite3ExternalPointerEntrypoint(entrypoint);
  await fs.writeFile(entrypointPath, entrypoint);

  let helpers = await fs.readFile(helpersPath, "utf8");
  helpers = patchBetterSqlite3SetNativeDataProperty(helpers);
  await fs.writeFile(helpersPath, helpers);
}

function patchBetterSqlite3ExternalPointerMacros(source) {
  if (source.includes("#define BETTER_SQLITE3_EXTERNAL_NEW")) {
    return source;
  }

  const externalPointerMacros = [
    "// Electron 42 enables V8 external pointer sandboxing; v8::External pointers need tags.",
    "// See V8's v8-external.h kExternalPointerTypeTagDefault notes.",
    "#if defined(V8_ENABLE_SANDBOX)",
    "#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New(isolate, value, v8::kExternalPointerTypeTagDefault)",
    "#define BETTER_SQLITE3_EXTERNAL_VALUE(external) (external)->Value(v8::kExternalPointerTypeTagDefault)",
    "#else",
    "#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New(isolate, value)",
    "#define BETTER_SQLITE3_EXTERNAL_VALUE(external) (external)->Value()",
    "#endif"
  ].join("\n");

  const onlyAddon = "#define OnlyAddon static_cast<Addon*>(BETTER_SQLITE3_EXTERNAL_VALUE(info.Data().As<v8::External>()))";
  const legacyAnchor = [
    "#define OnlyIsolate info.GetIsolate()",
    "#define OnlyContext isolate->GetCurrentContext()",
    "#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())"
  ].join("\n");
  const currentAnchor = [
    "#if defined(NODE_MODULE_VERSION) && NODE_MODULE_VERSION >= 146",
    "#define EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value), 0)",
    "#define EXTERNAL_VALUE(value) (value)->Value(0)",
    "#else",
    "#define EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value))",
    "#define EXTERNAL_VALUE(value) (value)->Value()",
    "#endif",
    "#define OnlyAddon static_cast<Addon*>(EXTERNAL_VALUE(info.Data().As<v8::External>()))"
  ].join("\n");

  if (source.includes(legacyAnchor)) {
    return replaceOnce(
      source,
      legacyAnchor,
      [
        "#define OnlyIsolate info.GetIsolate()",
        "#define OnlyContext isolate->GetCurrentContext()",
        "",
        externalPointerMacros,
        "",
        onlyAddon
      ].join("\n")
    );
  }

  if (source.includes(currentAnchor)) {
    return replaceOnce(source, currentAnchor, [externalPointerMacros, onlyAddon].join("\n"));
  }

  throw new Error("Unable to patch better-sqlite3 external pointer macros; unknown source shape");
}

function patchBetterSqlite3ExternalPointerEntrypoint(source) {
  const replacement = "v8::Local<v8::External> data = BETTER_SQLITE3_EXTERNAL_NEW(isolate, addon);";

  if (source.includes(replacement)) {
    return source;
  }

  if (source.includes("v8::Local<v8::External> data = EXTERNAL_NEW(isolate, addon);")) {
    return replaceOnce(
      source,
      "v8::Local<v8::External> data = EXTERNAL_NEW(isolate, addon);",
      replacement
    );
  }

  return replaceOnce(
    source,
    "v8::Local<v8::External> data = v8::External::New(isolate, addon);",
    replacement
  );
}

function patchBetterSqlite3SetNativeDataProperty(source) {
  if (source.includes("\t\tfunc,\n\t\tnullptr,\n\t\tdata")) {
    return source;
  }

  return replaceOnce(
    source,
    "\t\tfunc,\n\t\t0,\n\t\tdata",
    "\t\tfunc,\n\t\tnullptr,\n\t\tdata"
  );
}

async function buildLinuxArtifacts({
  stageAppDir,
  stageResourcesDir,
  outputDir,
  electronVersion,
  executableName,
  productName,
  desktopName,
  appId,
  linuxIconPath
}) {
  await run(
    [
      "npx",
      "--no-install",
      "electron-builder",
      "--config",
      "electron-builder.config.mjs",
      "--publish",
      "never",
      "--linux",
      "dir",
      "AppImage"
    ],
    {
      env: {
        ...process.env,
        CODEX_STAGE_APP_DIR: stageAppDir,
        CODEX_STAGE_RESOURCES_DIR: stageResourcesDir,
        CODEX_OUTPUT_DIR: outputDir,
        CODEX_ELECTRON_VERSION: electronVersion,
        CODEX_APP_EXECUTABLE_NAME: executableName,
        CODEX_PRODUCT_NAME: productName,
        CODEX_DESKTOP_NAME: desktopName,
        CODEX_APP_ID: appId,
        CODEX_LINUX_ICON_PATH: linuxIconPath
      }
    }
  );
}

export async function stagePackagedResources(resourcesDir, targetDir) {
  const entries = await fs.readdir(resourcesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (skippedLinuxResourceNames.has(entry.name)) {
      continue;
    }

    const sourcePath = path.join(resourcesDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    await copyRecursive(sourcePath, targetPath);

    if (entry.name === "plugins") {
      await prunePackagedPlugins(targetPath);
    }
  }
}

export async function stageLinuxCodexCliRuntime(targetDir) {
  const archivePath = await fetchVerifiedArchive(
    codexCliRuntime.url,
    codexCliRuntime.sha256,
    path.join(cacheRoot, "codex-cli-runtime")
  );
  const extractDir = path.join(targetDir, ".codex-cli-runtime-extract");
  const sourceCodex = path.join(extractDir, "bin", "codex");

  await ensureEmptyDir(extractDir);
  await run(["tar", "-xzf", archivePath, "-C", extractDir, codexCliRuntime.codexEntry]);
  await installLinuxRuntimeExecutable(sourceCodex, path.join(targetDir, "codex"));
  await fs.rm(extractDir, { recursive: true, force: true });
}

export async function stageLinuxNodeReplRuntime(targetDir) {
  const archivePath = await fetchVerifiedArchive(
    primaryRuntime.url,
    primaryRuntime.sha256,
    path.join(cacheRoot, "primary-runtime")
  );
  const extractDir = path.join(targetDir, ".primary-runtime-extract");
  const extractedRoot = path.join(extractDir, "codex-primary-runtime", "dependencies");
  const sourceNode = path.join(extractedRoot, "node", "bin", "node");
  const sourceNodeRepl = path.join(extractedRoot, "bin", "node_repl");

  await ensureEmptyDir(extractDir);
  await run([
    "tar",
    "-xJf",
    archivePath,
    "-C",
    extractDir,
    primaryRuntime.nodeEntry,
    primaryRuntime.nodeReplEntry
  ]);

  await installLinuxRuntimeExecutable(sourceNode, path.join(targetDir, "node"));
  await installLinuxRuntimeExecutable(sourceNodeRepl, path.join(targetDir, "node_repl"));
  await ensureDir(path.join(targetDir, "cua_node", "bin"));
  await installLinuxRuntimeExecutable(
    sourceNode,
    path.join(targetDir, "cua_node", "bin", "node")
  );
  await installLinuxRuntimeExecutable(
    sourceNodeRepl,
    path.join(targetDir, "cua_node", "bin", "node_repl")
  );
  await fs.rm(extractDir, { recursive: true, force: true });
}

async function fetchVerifiedArchive(url, expectedSha256, cacheDir) {
  await ensureDir(cacheDir);

  const archivePath = path.join(
    cacheDir,
    decodeURIComponent(new URL(url).pathname.split("/").at(-1))
  );

  try {
    await verifyFileSha256(archivePath, expectedSha256);
    return archivePath;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await fs.rm(archivePath, { force: true });
    }
  }

  await fetchArchive(url, cacheDir);
  await verifyFileSha256(archivePath, expectedSha256);

  return archivePath;
}

export async function installLinuxRuntimeExecutable(source, target) {
  const fileType = await run(["file", "-b", source], { capture: true });

  if (!/\bELF\b/.test(fileType) || !/\bx86-64\b/.test(fileType)) {
    throw new Error(`Refusing non-Linux x64 runtime ${source}: ${fileType.trim()}`);
  }

  await fs.copyFile(source, target);
  await fs.chmod(target, 0o755);
}

async function prunePackagedPlugins(pluginsDir) {
  const openaiBundledDir = path.join(pluginsDir, "openai-bundled");
  const bundledPluginsDir = path.join(openaiBundledDir, "plugins");

  for (const pluginName of skippedBundledPluginNames) {
    await fs.rm(path.join(bundledPluginsDir, pluginName), {
      recursive: true,
      force: true
    });
  }

  await filterBundledPluginMarketplace(
    path.join(openaiBundledDir, ".agents", "plugins", "marketplace.json")
  );
}

async function filterBundledPluginMarketplace(marketplacePath) {
  let marketplace;

  try {
    marketplace = JSON.parse(await fs.readFile(marketplacePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (!Array.isArray(marketplace.plugins)) {
    return;
  }

  marketplace.plugins = marketplace.plugins.filter(plugin => {
    return !skippedBundledPluginNames.has(plugin?.name);
  });

  await fs.writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
}

async function prunePlatformNativePrebuilds(stageAppDir) {
  const nodePtyPrebuildsDir = path.join(
    stageAppDir,
    "node_modules",
    "node-pty",
    "prebuilds"
  );

  let entries;

  try {
    entries = await fs.readdir(nodePtyPrebuildsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("linux-")) {
      continue;
    }

    await fs.rm(path.join(nodePtyPrebuildsDir, entry.name), {
      recursive: true,
      force: true
    });
  }
}

async function renameAppImage(outputDir, targetName) {
  const entries = await fs.readdir(outputDir);
  const current = entries.find(name => name.endsWith(".AppImage"));

  if (!current) {
    throw new Error(`No AppImage produced in ${outputDir}`);
  }

  const source = path.join(outputDir, current);
  const target = path.join(outputDir, targetName);

  if (source !== target) {
    await fs.rm(target, { force: true });
    await fs.rename(source, target);
  }

  return target;
}

async function packDirectory(sourceDir, archivePath) {
  await run(["tar", "-C", path.dirname(sourceDir), "-czf", archivePath, path.basename(sourceDir)]);
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const file = await fs.readFile(filePath);

  hash.update(file);

  return hash.digest("hex");
}

async function verifyFileSha256(filePath, expectedSha256) {
  const actualSha256 = await sha256File(filePath);

  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Checksum mismatch for ${filePath}: expected ${expectedSha256}, got ${actualSha256}`
    );
  }
}

function replaceOnce(source, search, replacement) {
  const index = source.indexOf(search);

  if (index === -1) {
    throw new Error(`Unable to patch source; missing anchor: ${search.slice(0, 80)}`);
  }

  if (source.indexOf(search, index + search.length) !== -1) {
    throw new Error(`Unable to patch source; ambiguous anchor: ${search.slice(0, 80)}`);
  }

  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

async function assembleNpmPackage({
  channel,
  upstream,
  packageName,
  packageVersion,
  launcherCommand,
  releaseRepo,
  releaseTag,
  executableName,
  unpackedTarballAssetName,
  unpackedTarballSha256,
  targetDir
}) {
  const packageDir = path.join(targetDir, "package");
  const binDir = path.join(packageDir, "bin");
  const runtimeDir = path.join(packageDir, "runtime");

  await ensureEmptyDir(packageDir);
  await ensureDir(binDir);
  await copyRecursive(path.join(projectRoot, "runtime"), runtimeDir);

  const packageJson = createRuntimePackageManifest({
    channel,
    packageName,
    packageVersion,
    launcherCommand,
    releaseRepo,
    releaseTag,
    executableName,
    unpackedTarballAssetName,
    unpackedTarballSha256
  });

  await fs.writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`
  );
  await fs.writeFile(
    path.join(binDir, "codex-app-linux.mjs"),
    launcherScript(),
    { mode: 0o755 }
  );
  await fs.writeFile(
    path.join(packageDir, "README.md"),
    launcherReadme({
      packageName,
      launcherCommand,
      channelName: channel.name,
      upstream,
      releaseRepo,
      releaseTag,
      executableName,
      unpackedTarballAssetName
    })
  );

  return packageDir;
}

export function createRuntimePackageManifest({
  channel,
  packageName,
  packageVersion,
  launcherCommand,
  releaseRepo,
  releaseTag,
  executableName,
  unpackedTarballAssetName,
  unpackedTarballSha256
}) {
  return {
    name: packageName,
    version: packageVersion,
    private: false,
    type: "module",
    description: `${channel.displayName} launcher for the Codex Linux desktop app. Requires an existing codex CLI on PATH.`,
    license: "UNLICENSED",
    os: ["linux"],
    cpu: ["x64"],
    engines: {
      node: ">=20"
    },
    bin: {
      [launcherCommand]: "bin/codex-app-linux.mjs"
    },
    files: ["bin", "runtime", "README.md", "package.json"],
    dependencies: {
      "@electron/asar": "^4.1.0",
      ws: "^8.20.0"
    },
    repository: {
      type: "git",
      url: `git+https://github.com/${releaseRepo}.git`
    },
    codexAppLinux: {
      channel: channel.name,
      releaseRepo,
      releaseTag,
      executableName,
      unpackedTarballAssetName,
      unpackedTarballSha256
    },
    publishConfig: {
      access: "public",
      tag: channel.distTag
    }
  };
}

function launcherScript() {
  return `#!/usr/bin/env node
import "../runtime/launcher.mjs";
`;
}

function launcherReadme({
  packageName,
  launcherCommand,
  channelName,
  upstream,
  releaseRepo,
  releaseTag,
  executableName,
  unpackedTarballAssetName
}) {
  return `# ${packageName}

Thin launcher for the Codex Linux desktop app.

- Channel: \`${channelName}\`
- Upstream desktop version: \`${upstream.version}\`
- Upstream build number: \`${upstream.buildNumber}\`
- GitHub release: \`${releaseTag}\`
- Linux archive asset: \`${unpackedTarballAssetName}\`
- Executable: \`${executableName}\`
- Release repo: \`${releaseRepo}\`

## Behavior

1. uses existing \`CODEX_CLI_PATH\` if set
2. otherwise resolves \`which codex\`
3. downloads the Linux unpacked binary archive from GitHub Releases into cache on first run
4. extracts \`linux-unpacked\`
5. launches the packaged executable with \`CODEX_CLI_PATH\` exported

## Browser Mode

Serve the bundled Codex UI in your browser:

\`\`\`bash
${launcherCommand} web --open
\`\`\`

## Usage

\`\`\`bash
${launcherCommand}
\`\`\`
`;
}

async function copyRecursive(source, target) {
  await fs.cp(source, target, { recursive: true });
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function ensureEmptyDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function run(command, options = {}) {
  const { capture = false, env, cwd = projectRoot } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", chunk => {
        stderr += chunk.toString();
      });
    }

    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      const detail = capture ? `\n${stderr}` : "";
      reject(new Error(`Command failed (${command.join(" ")}): ${code}${detail}`));
    });
  });
}
