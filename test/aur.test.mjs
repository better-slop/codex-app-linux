import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { archPkgverFor, writeAurPackage } from "../scripts/lib/aur.mjs";

test("archPkgverFor replaces hyphens for Arch package versions", () => {
  assert.equal(
    archPkgverFor("26.313.41514-beta.1041.launcher.1"),
    "26.313.41514_beta.1041.launcher.1"
  );
});

test("writeAurPackage emits PKGBUILD, .SRCINFO, and install script", async () => {
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-aur-"));

  const result = await writeAurPackage({
    channel: {
      displayName: "Codex",
      aurPackageName: "codex-app-linux-bin"
    },
    packageVersion: "26.313.41514-launcher.1",
    releaseRepo: "better-slop/codex-app-linux",
    releaseTag: "v26.313.41514-launcher.1",
    executableName: "codex-app-linux",
    tarballAssetName: "codex-app-linux-26.313.41514-launcher.1-x64-linux-unpacked.tar.gz",
    tarballSha256: "tarball-sha",
    iconAssetName: "codex-app-linux-26.313.41514-launcher.1-x64.png",
    iconSha256: "icon-sha",
    targetDir
  });

  assert.equal(result.pkgname, "codex-app-linux-bin");
  assert.equal(result.pkgver, "26.313.41514_launcher.1");
  assert.equal(
    result.aurUrl,
    "https://aur.archlinux.org/packages/codex-app-linux-bin"
  );

  const pkgbuild = await fs.readFile(result.pkgbuildPath, "utf8");
  const srcinfo = await fs.readFile(result.srcinfoPath, "utf8");
  const installScript = await fs.readFile(result.installPath, "utf8");

  assert.match(pkgbuild, /pkgname='codex-app-linux-bin'/);
  assert.match(pkgbuild, /Exec=codex-app-linux %U/);
  assert.match(pkgbuild, /linux-unpacked/);
  assert.match(srcinfo, /pkgbase = codex-app-linux-bin/);
  assert.match(srcinfo, /pkgver = 26.313.41514_launcher.1/);
  assert.match(installScript, /expects an existing 'codex' binary on PATH/);
});
