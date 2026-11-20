import { fileURLToPath } from "node:url";

/** Run records go here (git-ignored, removed by `make clean`). */
export const DEFAULT_RUNS_DIR = fileURLToPath(new URL("../runs/", import.meta.url));

/** 20261118-143005, in local time: sorts by date and is safe in file names. */
export function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
