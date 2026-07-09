import { spawn } from "node:child_process";

spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
  stdio: ["ignore", "inherit", "inherit"]
});
setInterval(() => {}, 60_000);
