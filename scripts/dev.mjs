// Runs the API server (with reload) and the Vite dev server side by side.
import { spawn } from "node:child_process";

const procs = [
  spawn("npx", ["tsx", "watch", "src/server/index.ts"], { stdio: "inherit", shell: process.platform === "win32" }),
  spawn("npx", ["vite"], { stdio: "inherit", shell: process.platform === "win32" }),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => code && stop());
