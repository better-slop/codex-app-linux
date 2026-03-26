import fs from "node:fs/promises";
import path from "node:path";

export async function writeAurPackage({
  channel,
  packageVersion,
  releaseRepo,
  releaseTag,
  executableName,
  tarballAssetName,
  tarballSha256,
  iconAssetName,
  iconSha256,
  targetDir
}) {
  const pkgname = channel.aurPackageName;
  const appDirName = executableName;
  const desktopId = executableName;
  const pkgver = archPkgverFor(packageVersion);
  const url = `https://github.com/${releaseRepo}`;
  const releaseBaseUrl = `${url}/releases/download/${releaseTag}`;
  const tarballSourceUrl = `${releaseBaseUrl}/${tarballAssetName}`;
  const iconSourceUrl = `${releaseBaseUrl}/${iconAssetName}`;
  const pkgbuildPath = path.join(targetDir, "PKGBUILD");
  const srcinfoPath = path.join(targetDir, ".SRCINFO");
  const installPath = path.join(targetDir, `${pkgname}.install`);

  await fs.mkdir(targetDir, { recursive: true });

  const metadata = {
    pkgname,
    pkgver,
    packageVersion,
    aurUrl: `https://aur.archlinux.org/packages/${pkgname}`,
    pkgbuildPath,
    srcinfoPath,
    installPath
  };

  const pkgbuild = renderPkgbuild({
    channel,
    pkgname,
    pkgver,
    url,
    executableName,
    appDirName,
    desktopId,
    tarballAssetName,
    tarballSourceUrl,
    tarballSha256,
    iconAssetName,
    iconSourceUrl,
    iconSha256
  });
  const srcinfo = renderSrcinfo({
    channel,
    pkgname,
    pkgver,
    url,
    tarballAssetName,
    tarballSourceUrl,
    tarballSha256,
    iconAssetName,
    iconSourceUrl,
    iconSha256
  });
  const installScript = renderInstallScript({ pkgname });

  await fs.writeFile(pkgbuildPath, pkgbuild);
  await fs.writeFile(srcinfoPath, srcinfo);
  await fs.writeFile(installPath, installScript);

  return metadata;
}

export function archPkgverFor(version) {
  return String(version).replaceAll("-", "_");
}

function renderPkgbuild({
  channel,
  pkgname,
  pkgver,
  url,
  executableName,
  appDirName,
  desktopId,
  tarballAssetName,
  tarballSourceUrl,
  tarballSha256,
  iconAssetName,
  iconSourceUrl,
  iconSha256
}) {
  const pkgdesc = aurPkgdesc(channel);

  return `pkgname=${shellQuote(pkgname)}
pkgver=${shellQuote(pkgver)}
pkgrel=1
pkgdesc=${shellQuote(pkgdesc)}
arch=('x86_64')
url=${shellQuote(url)}
license=('custom')
depends=('alsa-lib' 'gtk3' 'libnotify' 'libsecret' 'libxss' 'nss' 'xdg-utils')
install=${shellQuote(`${pkgname}.install`)}
source=(
  ${shellQuote(`${tarballAssetName}::${tarballSourceUrl}`)}
  ${shellQuote(`${iconAssetName}::${iconSourceUrl}`)}
)
sha256sums=(
  ${shellQuote(tarballSha256)}
  ${shellQuote(iconSha256)}
)

package() {
  install -dm755 "\${pkgdir}/opt/${appDirName}"
  cp -a "\${srcdir}/linux-unpacked/." "\${pkgdir}/opt/${appDirName}/"

  install -dm755 "\${pkgdir}/usr/bin"
  ln -s "/opt/${appDirName}/${executableName}" "\${pkgdir}/usr/bin/${executableName}"

  install -Dm644 "\${srcdir}/${iconAssetName}" \
    "\${pkgdir}/usr/share/icons/hicolor/512x512/apps/${desktopId}.png"

  cat > "${desktopId}.desktop" <<'EOF'
[Desktop Entry]
Name=${channel.displayName}
Comment=Launch ${channel.displayName} on Linux
Exec=${executableName} %U
Terminal=false
Type=Application
Icon=${desktopId}
Categories=Development;
StartupNotify=true
EOF

  install -Dm644 "${desktopId}.desktop" \
    "\${pkgdir}/usr/share/applications/${desktopId}.desktop"

  install -Dm644 "\${pkgdir}/opt/${appDirName}/LICENSE.electron.txt" \
    "\${pkgdir}/usr/share/licenses/${pkgname}/LICENSE.electron.txt"
}
`;
}

function renderSrcinfo({
  channel,
  pkgname,
  pkgver,
  url,
  tarballAssetName,
  tarballSourceUrl,
  tarballSha256,
  iconAssetName,
  iconSourceUrl,
  iconSha256
}) {
  const pkgdesc = aurPkgdesc(channel);

  return `pkgbase = ${pkgname}
\tpkgdesc = ${pkgdesc}
\tpkgver = ${pkgver}
\tpkgrel = 1
\turl = ${url}
\tarch = x86_64
\tlicense = custom
\tdepends = alsa-lib
\tdepends = gtk3
\tdepends = libnotify
\tdepends = libsecret
\tdepends = libxss
\tdepends = nss
\tdepends = xdg-utils
\tinstall = ${pkgname}.install
\tsource = ${tarballAssetName}::${tarballSourceUrl}
\tsource = ${iconAssetName}::${iconSourceUrl}
\tsha256sums = ${tarballSha256}
\tsha256sums = ${iconSha256}

pkgname = ${pkgname}
`;
}

function renderInstallScript({ pkgname }) {
  return `post_install() {
  cat <<'EOF'
${pkgname} expects an existing 'codex' binary on PATH.
If Codex CLI is installed somewhere else, set CODEX_CLI_PATH before launch.
EOF
}

post_upgrade() {
  post_install
}
`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function aurPkgdesc(channel) {
  return channel.prerelease
    ? "Unofficial Linux build of Codex Beta from OpenAI's Codex beta appcast feed."
    : "Unofficial Linux build of Codex from OpenAI's Codex appcast feed.";
}
