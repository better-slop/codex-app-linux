const stageAppDir = process.env.CODEX_STAGE_APP_DIR;
const outputDir = process.env.CODEX_OUTPUT_DIR;
const executableName = process.env.CODEX_APP_EXECUTABLE_NAME || "codex-app-linux";
const appId = process.env.CODEX_APP_ID || "com.openai.codex.linux";
const productName = process.env.CODEX_PRODUCT_NAME || "Codex";
const desktopName = process.env.CODEX_DESKTOP_NAME || productName;
const linuxIconPath = process.env.CODEX_LINUX_ICON_PATH;
const electronVersion = process.env.CODEX_ELECTRON_VERSION;

if (!stageAppDir) {
  throw new Error("CODEX_STAGE_APP_DIR is required");
}

if (!outputDir) {
  throw new Error("CODEX_OUTPUT_DIR is required");
}

if (!electronVersion) {
  throw new Error("CODEX_ELECTRON_VERSION is required");
}

export default {
  appId,
  productName,
  afterPack: "scripts/electron-builder-after-pack.cjs",
  directories: {
    app: stageAppDir,
    output: outputDir
  },
  electronVersion,
  npmRebuild: false,
  buildDependenciesFromSource: false,
  asar: true,
  files: [
    {
      from: ".",
      filter: [
        "**/*",
        ".vite/**/*",
        "!**/.DS_Store",
        "!**/*.map"
      ]
    }
  ],
  linux: {
    target: ["dir", "AppImage"],
    executableName,
    category: "Development",
    description: `${desktopName} for Linux`,
    artifactName: "${productName}-${version}-${arch}.${ext}",
    icon: linuxIconPath,
    desktop: {
      entry: {
        Name: desktopName,
        StartupWMClass: desktopName
      }
    }
  }
};
