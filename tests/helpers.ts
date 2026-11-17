import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** A local git repository with two commits, used as the "remote". */
export async function makeSourceRepo(dir: string): Promise<string> {
  await mkdir(path.join(dir, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });
  git("init", "-q");
  await writeFile(path.join(dir, "README.md"), "# demo\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  await writeFile(path.join(dir, "src/app.py"), "print('hi')\n");
  git("add", ".");
  git("commit", "-q", "-m", "second");
  return pathToFileURL(dir).href;
}

