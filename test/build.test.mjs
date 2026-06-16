import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  installLinuxRuntimeExecutable,
  patchBetterSqlite3NativeSource,
  stagePackagedResources
} from "../scripts/lib/build.mjs";

test("stagePackagedResources preserves Linux-safe upstream resources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-build-test-"));
  const resourcesDir = path.join(root, "Resources");
  const targetDir = path.join(root, "staged");

  await fs.mkdir(path.join(resourcesDir, "plugins", "openai-bundled", ".agents", "plugins"), { recursive: true });
  await fs.mkdir(path.join(resourcesDir, "plugins", "openai-bundled", "plugins", "browser-use"), { recursive: true });
  await fs.mkdir(path.join(resourcesDir, "plugins", "openai-bundled", "plugins", "computer-use"), { recursive: true });
  await fs.mkdir(path.join(resourcesDir, "plugins", "openai-bundled", "plugins", "latex-tectonic", "bin"), { recursive: true });
  await fs.mkdir(path.join(resourcesDir, "native"), { recursive: true });
  await fs.mkdir(path.join(resourcesDir, "app.asar.unpacked", "node_modules"), { recursive: true });
  await fs.writeFile(path.join(resourcesDir, "app.asar"), "asar");
  await fs.writeFile(
    path.join(resourcesDir, "app.asar.unpacked", "node_modules", "better_sqlite3.node"),
    "darwin-native"
  );
  await fs.writeFile(
    path.join(resourcesDir, "plugins", "openai-bundled", ".agents", "plugins", "marketplace.json"),
    JSON.stringify(
      {
        name: "openai-bundled",
        plugins: [
          { name: "browser-use", source: { source: "local", path: "./plugins/browser-use" } },
          { name: "computer-use", source: { source: "local", path: "./plugins/computer-use" } },
          { name: "latex-tectonic", source: { source: "local", path: "./plugins/latex-tectonic" } }
        ]
      },
      null,
      2
    ) + "\n"
  );
  await fs.writeFile(
    path.join(resourcesDir, "plugins", "openai-bundled", "plugins", "browser-use", "plugin.json"),
    "browser-use"
  );
  await fs.writeFile(
    path.join(resourcesDir, "plugins", "openai-bundled", "plugins", "computer-use", "plugin.json"),
    "computer-use"
  );
  await fs.writeFile(
    path.join(resourcesDir, "plugins", "openai-bundled", "plugins", "latex-tectonic", "bin", "tectonic"),
    "darwin-tectonic"
  );
  await fs.writeFile(path.join(resourcesDir, "codex"), "darwin-codex");
  await fs.mkdir(path.join(resourcesDir, "cua_node", "bin"), { recursive: true });
  await fs.writeFile(path.join(resourcesDir, "cua_node", "bin", "node_repl"), "darwin-node-repl");
  await fs.writeFile(path.join(resourcesDir, "node"), "darwin-node");
  await fs.writeFile(path.join(resourcesDir, "rg"), "darwin-rg");
  await fs.writeFile(path.join(resourcesDir, "native", "browser-use-peer-authorization.node"), "native");
  await fs.writeFile(path.join(resourcesDir, "electron.icns"), "icon");

  await fs.mkdir(targetDir, { recursive: true });
  await stagePackagedResources(resourcesDir, targetDir);

  await assert.rejects(fs.access(path.join(targetDir, "app.asar")));
  await assert.rejects(fs.access(path.join(targetDir, "app.asar.unpacked")));
  await assert.rejects(fs.access(path.join(targetDir, "codex")));
  await assert.rejects(fs.access(path.join(targetDir, "cua_node")));
  await assert.rejects(fs.access(path.join(targetDir, "node")));
  await assert.rejects(fs.access(path.join(targetDir, "rg")));
  await assert.rejects(fs.access(path.join(targetDir, "native")));
  await assert.rejects(fs.access(path.join(targetDir, "plugins", "openai-bundled", "plugins", "computer-use")));
  await assert.rejects(fs.access(path.join(targetDir, "plugins", "openai-bundled", "plugins", "latex-tectonic")));
  assert.equal(
    await fs.readFile(
      path.join(targetDir, "plugins", "openai-bundled", "plugins", "browser-use", "plugin.json"),
      "utf8"
    ),
    "browser-use"
  );
  const marketplace = JSON.parse(
    await fs.readFile(
      path.join(targetDir, "plugins", "openai-bundled", ".agents", "plugins", "marketplace.json"),
      "utf8"
    )
  );
  assert.deepEqual(
    marketplace.plugins.map(plugin => plugin.name),
    ["browser-use"]
  );
  assert.equal(
    await fs.readFile(path.join(targetDir, "electron.icns"), "utf8"),
    "icon"
  );
});

test("installLinuxRuntimeExecutable only accepts Linux x64 ELF executables", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-runtime-test-"));
  const fakeMachO = path.join(root, "node_repl");
  const target = path.join(root, "target");

  await fs.writeFile(fakeMachO, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));

  await assert.rejects(
    installLinuxRuntimeExecutable(fakeMachO, target),
    /Refusing non-Linux x64 runtime/
  );
  await installLinuxRuntimeExecutable("/bin/true", target);

  const mode = (await fs.stat(target)).mode & 0o777;
  assert.equal(mode, 0o755);
});

test("patchBetterSqlite3NativeSource updates V8 external pointer calls", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-native-test-"));
  const packageDir = path.join(root, "better-sqlite3");
  const utilDir = path.join(packageDir, "src", "util");
  const srcDir = path.join(packageDir, "src");

  await fs.mkdir(utilDir, { recursive: true });
  await fs.writeFile(
    path.join(utilDir, "macros.cpp"),
    [
      "#define OnlyIsolate info.GetIsolate()",
      "#define OnlyContext isolate->GetCurrentContext()",
      "#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())",
      "#define UseAddon Addon* addon = OnlyAddon"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(utilDir, "helpers.cpp"),
    [
      "recv->InstanceTemplate()->SetNativeDataProperty(",
      "\t\tInternalizedFromLatin1(isolate, name),",
      "\t\tfunc,",
      "\t\t0,",
      "\t\tdata",
      "\t);"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(srcDir, "better_sqlite3.cpp"),
    "v8::Local<v8::External> data = v8::External::New(isolate, addon);"
  );

  await patchBetterSqlite3NativeSource(packageDir);

  assert.match(
    await fs.readFile(path.join(utilDir, "macros.cpp"), "utf8"),
    /BETTER_SQLITE3_EXTERNAL_VALUE\(info\.Data\(\)\.As<v8::External>\(\)\)/
  );
  assert.match(
    await fs.readFile(path.join(srcDir, "better_sqlite3.cpp"), "utf8"),
    /BETTER_SQLITE3_EXTERNAL_NEW\(isolate, addon\)/
  );
  assert.match(
    await fs.readFile(path.join(utilDir, "helpers.cpp"), "utf8"),
    /\t\tnullptr,\n\t\tdata/
  );
});

test("patchBetterSqlite3NativeSource updates newer better-sqlite3 external helpers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-native-test-"));
  const packageDir = path.join(root, "better-sqlite3");
  const utilDir = path.join(packageDir, "src", "util");
  const srcDir = path.join(packageDir, "src");

  await fs.mkdir(utilDir, { recursive: true });
  await fs.writeFile(
    path.join(utilDir, "macros.cpp"),
    [
      "#define OnlyIsolate info.GetIsolate()",
      "#define OnlyContext isolate->GetCurrentContext()",
      "#if defined(NODE_MODULE_VERSION) && NODE_MODULE_VERSION >= 146",
      "#define EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value), 0)",
      "#define EXTERNAL_VALUE(value) (value)->Value(0)",
      "#else",
      "#define EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value))",
      "#define EXTERNAL_VALUE(value) (value)->Value()",
      "#endif",
      "#define OnlyAddon static_cast<Addon*>(EXTERNAL_VALUE(info.Data().As<v8::External>()))",
      "#define UseAddon Addon* addon = OnlyAddon"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(utilDir, "helpers.cpp"),
    [
      "recv->InstanceTemplate()->SetNativeDataProperty(",
      "\t\tInternalizedFromLatin1(isolate, name),",
      "\t\tfunc,",
      "\t\tnullptr,",
      "\t\tdata",
      "\t);"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(srcDir, "better_sqlite3.cpp"),
    "v8::Local<v8::External> data = EXTERNAL_NEW(isolate, addon);"
  );

  await patchBetterSqlite3NativeSource(packageDir);

  assert.match(
    await fs.readFile(path.join(utilDir, "macros.cpp"), "utf8"),
    /BETTER_SQLITE3_EXTERNAL_VALUE\(info\.Data\(\)\.As<v8::External>\(\)\)/
  );
  assert.match(
    await fs.readFile(path.join(srcDir, "better_sqlite3.cpp"), "utf8"),
    /BETTER_SQLITE3_EXTERNAL_NEW\(isolate, addon\)/
  );
  assert.match(
    await fs.readFile(path.join(utilDir, "helpers.cpp"), "utf8"),
    /\t\tnullptr,\n\t\tdata/
  );
});
