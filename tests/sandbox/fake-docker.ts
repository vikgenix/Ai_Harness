import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A stand-in `docker` command for tests: it logs each call (as a JSON array
 * per line) and runs `docker exec ... sh|bash -c <script>` on this machine, as
 * if the container were here. Environment switches:
 *   FAKE_DOCKER_DOWN=1      the daemon is not running
 *   FAKE_DOCKER_NO_IMAGE=1  the image has to be pulled
 */
const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\n");
const fail = (msg, code = 1) => { process.stderr.write(msg + "\n"); process.exit(code); };
switch (args[0]) {
  case "version":
    if (process.env.FAKE_DOCKER_DOWN) fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
    console.log("29.0.0");
    break;
  case "image":
    process.exit(process.env.FAKE_DOCKER_NO_IMAGE ? 1 : 0);
  case "run":
    console.log("0123456789ab");
    break;
  case "exec": {
    let i = 1, cwd, env = {};
    while (args[i].startsWith("--")) {
      if (args[i] === "--workdir") cwd = args[i + 1];
      if (args[i] === "--env") { const [k, ...v] = args[i + 1].split("="); env[k] = v.join("="); }
      i += 2;
    }
    const rest = args.slice(i + 1); // after the container name
    if ((rest[0] === "sh" || rest[0] === "bash") && rest[1] === "-c") {
      if (rest[2] === "command -v git") process.exit(1);
      if (rest[2] === 'printf %s "$PATH"') { process.stdout.write("/usr/local/bin:/usr/bin:/bin"); process.exit(0); }
      const r = spawnSync("bash", ["-c", rest[2]], { cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(), env: { ...process.env, ...env }, stdio: "inherit" });
      process.exit(r.status ?? 1);
    }
    if (rest[0] === "python3") { console.log("Python 3.12.4"); break; }
    fail('OCI runtime exec failed: exec failed: unable to start container process: exec: "' + rest[0] + '": executable file not found in $PATH', 127);
  }
  default: // ps, pull, rm
}
`;

/** Puts a fake `docker` in `dir`; returns how to read its log. */
export async function installFakeDocker(dir: string): Promise<{ bin: string; log: string; calls(): Promise<string[][]> }> {
  const log = path.join(dir, "docker-log.jsonl");
  await writeFile(path.join(dir, "docker"), SCRIPT, { mode: 0o755 });
  await writeFile(log, "");
  return {
    bin: dir,
    log,
    calls: async () =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]),
  };
}
