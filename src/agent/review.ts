import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isTestPath } from "../repo/map.js";
import type { FinishInput } from "../tools/finish.js";
import { git, NOT_JUNK, type FixBranch } from "./fix.js";

/**
 * Self-review for /fix. The first time the agent calls finish with
 * "completed", the harness holds the finish back and shows the agent its whole
 * diff, with problems found automatically (debugging leftovers, scratch files,
 * a missing or weakened test, formatting-only edits) and a short checklist.
 * The agent fixes what it finds and calls finish again.
 *
 * It runs in the same conversation, so it costs one extra step on a cached
 * prompt rather than a separate review by another model call.
 */

/** The diff shown to the agent is cut beyond this. */
export const MAX_REVIEW_DIFF_CHARS = 20_000;
/** Reviews per fix: a second one only if the agent changed files and problems remain. */
export const MAX_REVIEW_ROUNDS = 2;
/** Findings of one kind listed before "... and N more". */
const MAX_FINDINGS_PER_CHECK = 5;

export interface ChangedFile {
  path: string;
  /** git status letter: A added, M modified, D deleted, R renamed. */
  status: string;
  added: number;
  removed: number;
  /** True if the file only changed in whitespace. */
  whitespaceOnly: boolean;
}

export interface Changes {
  files: ChangedFile[];
  /** Unified diff against the fix's base commit, including new files. */
  patch: string;
}

/**
 * Everything changed on the fix branch since its base: committed or not,
 * tracked or new (caches excluded). Uses a temporary index, so the real one
 * is not touched.
 */
export async function collectChanges(dir: string, fix: FixBranch): Promise<Changes> {
  const index = path.join(tmpdir(), `harness-review-${process.pid}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(dir, ["read-tree", "HEAD"], env);
    await git(dir, ["add", "-A", ...NOT_JUNK], env);
    const diff = (...args: string[]) => git(dir, ["diff", "--cached", "--no-color", "--no-ext-diff", "-M", ...args, fix.base], env);
    const [nameStatus, numstat, numstatW, patch] = await Promise.all([
      diff("--name-status"),
      diff("--numstat"),
      diff("--numstat", "-w"),
      diff(),
    ]);
    const counts = parseNumstat(numstat);
    const countsW = parseNumstat(numstatW);
    const files = nameStatus
      .split("\n")
      .filter(Boolean)
      .map((line): ChangedFile => {
        const parts = line.split("\t");
        const status = parts[0]![0]!;
        const file = parts[parts.length - 1]!;
        const c = counts.get(file) ?? { added: 0, removed: 0 };
        const w = countsW.get(file);
        const textChange = c.added + c.removed > 0;
        return { path: file, status, ...c, whitespaceOnly: status === "M" && textChange && (!w || w.added + w.removed === 0) };
      });
    return { files, patch };
  } finally {
    await rm(index, { force: true });
  }
}

function parseNumstat(text: string): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>();
  for (const line of text.split("\n").filter(Boolean)) {
    const [a = "0", r = "0", ...rest] = line.split("\t");
    const name = rest.join("\t").replace(/^(.*)\{.* => (.*)\}(.*)$/, "$1$2$3").replace(/^.* => /, ""); // renames: new name
    out.set(name, { added: Number(a) || 0, removed: Number(r) || 0 }); // binary files show "-"
  }
  return out;
}

/** Added and removed lines of a patch, with the file and (for added lines) the new line number. */
interface PatchLine {
  file: string;
  line: number;
  text: string;
  kind: "+" | "-";
}

export function patchLines(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let file = "";
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ")) {
      const old = raw.slice(4).replace(/^a\//, "");
      if (old !== "/dev/null") file = old; // a deleted file has "+++ /dev/null"
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) out.push({ file, line: newLine++, text: raw.slice(1), kind: "+" });
    else if (raw.startsWith("-")) out.push({ file, line: newLine, text: raw.slice(1), kind: "-" });
    else if (raw.startsWith(" ")) newLine++;
  }
  return out;
}

const DEBUG_CHECKS: { pattern: RegExp; what: string; inTests: boolean }[] = [
  { pattern: /^(<{7}|>{7}|={7})( |$)/, what: "merge conflict marker", inTests: true },
  { pattern: /\bbreakpoint\(\)|\bi?pdb\.set_trace\(|^\s*import i?pdb\b|^\s*debugger;?\s*$|\bbinding\.pry\b/, what: "debugger call", inTests: true },
  { pattern: /\bconsole\.(log|debug|trace)\(|^\s*print\(|\bSystem\.out\.print|\bdbg!\(|\bfmt\.Print|\bvar_dump\(|^\s*(p|pp|puts) /, what: "print/log statement", inTests: false },
  { pattern: /\b(TODO|FIXME|XXX|HACK)\b/, what: "TODO/FIXME note", inTests: true },
];

const SCRATCH_FILE = /(^|\/)((repro|reproduce|scratch|tmp|temp|debug|try|sandbox)[\w.-]*|nohup\.out|[\w.-]+\.(orig|rej|bak|swp|log|tmp))$/i;
const ASSERTION = /\bassert|\bexpect\(|\.assert[A-Z]\w*\(|\bdef test_|^\s*(it|test)\(|@Test\b|\bt\.(Error|Fatal)/;

/** Problems found in the changes without a model: each one is a line for the agent to check. */
export function findProblems(changes: Changes): string[] {
  const findings: string[] = [];
  const add = (items: string[], heading: string) => {
    if (!items.length) return;
    const shown = items.slice(0, MAX_FINDINGS_PER_CHECK).join("; ");
    findings.push(`${heading}: ${shown}${items.length > MAX_FINDINGS_PER_CHECK ? `; and ${items.length - MAX_FINDINGS_PER_CHECK} more` : ""}`);
  };

  const lines = patchLines(changes.patch);
  for (const check of DEBUG_CHECKS) {
    const hits = lines
      .filter((l) => l.kind === "+" && (check.inTests || !isTestPath(l.file)) && check.pattern.test(l.text))
      .map((l) => `${l.file}:${l.line} \`${l.text.trim().slice(0, 60)}\``);
    add(hits, `Added ${check.what} (remove it unless the fix needs it)`);
  }

  add(
    changes.files.filter((f) => f.status === "A" && SCRATCH_FILE.test(f.path)).map((f) => f.path),
    "New file that looks temporary (delete it, or keep it only as a real test)",
  );
  add(
    changes.files.filter((f) => f.whitespaceOnly).map((f) => f.path),
    "Only whitespace or formatting changed (revert these files)",
  );

  const tests = changes.files.filter((f) => isTestPath(f.path));
  if (changes.files.length && !tests.some((f) => f.status !== "D")) {
    findings.push("No test file was added or changed. Add a regression test in the project's test suite, or say in the summary why there is none.");
  }
  add(
    tests.filter((f) => f.status === "D").map((f) => f.path),
    "Test file deleted (tests must not be removed to make the suite pass)",
  );
  const testLines = lines.filter((l) => isTestPath(l.file) && ASSERTION.test(l.text));
  const lost = testLines.filter((l) => l.kind === "-").length - testLines.filter((l) => l.kind === "+").length;
  if (lost > 0) findings.push(`Tests lost ${lost} assertion ${lost === 1 ? "line" : "lines"}: make sure no existing test was deleted or weakened.`);

  const code = changes.files.filter((f) => !isTestPath(f.path));
  if (code.length > 8) findings.push(`${code.length} non-test files changed: make sure each one is needed for this task.`);
  return findings;
}

export interface Review {
  /** Sent to the agent as the result of its held-back finish call. */
  message: string;
  /** One line for the terminal. */
  note: string;
  findings: string[];
}

/** The review message for the agent. */
export function reviewMessage(changes: Changes, findings: string[], fix: FixBranch, round: number): string {
  if (!changes.files.length) {
    return [
      "Self-review: your finish call was held back because no file has changed since the task started.",
      "If the problem is real, make the fix and test it, then call finish again. If no change is needed, call finish with outcome 'blocked' and explain why.",
    ].join("\n");
  }
  const added = changes.files.reduce((n, f) => n + f.added, 0);
  const removed = changes.files.reduce((n, f) => n + f.removed, 0);
  const stat = changes.files.map((f) => `  ${f.status} ${f.path} (+${f.added} -${f.removed})`);
  const patch =
    changes.patch.length > MAX_REVIEW_DIFF_CHARS
      ? `${changes.patch.slice(0, MAX_REVIEW_DIFF_CHARS)}\n… (diff cut: ${changes.patch.length - MAX_REVIEW_DIFF_CHARS} more characters; view the files to see the rest)`
      : changes.patch;
  return [
    `Self-review${round > 1 ? ` (round ${round})` : ""}: your finish call was held back so you can check your changes first.`,
    `Changes since ${fix.baseName}: ${changes.files.length} ${changes.files.length === 1 ? "file" : "files"}, +${added} -${removed}`,
    ...stat,
    "",
    findings.length ? "Automatic checks found:" : "Automatic checks found nothing.",
    ...findings.map((f) => `- ${f}`),
    "",
    "Check the diff below:",
    "1. Every change is needed for the task: no unrelated edits, reformatting or renames.",
    "2. No debugging output, commented-out code, scratch scripts or temporary files are left.",
    "3. A regression test covers the problem, and no existing test was deleted or weakened.",
    "4. The fix addresses the root cause and the cases the task mentions.",
    "If something needs changing, change it and run the tests again. Then call finish again (you may revise the summary); it will be accepted.",
    "",
    "<diff>",
    patch,
    "</diff>",
  ].join("\n");
}

/**
 * The self-review for one fix: `check` is called with each finish call and
 * returns a review while the finish should be held back.
 */
export function createSelfReview(dir: string, fix: FixBranch) {
  let rounds = 0;
  let lastPatch: string | undefined;
  const findings: string[] = [];
  return {
    get rounds() {
      return rounds;
    },
    /** Every finding of every round, for the run record. */
    findings,
    async check(input: FinishInput): Promise<Review | undefined> {
      if (input.outcome !== "completed" || rounds >= MAX_REVIEW_ROUNDS) return undefined;
      let changes: Changes;
      try {
        changes = await collectChanges(dir, fix);
      } catch {
        return undefined; // the review helps but never stops a fix
      }
      const found = findProblems(changes);
      // After the first review, only look again if the agent changed something and problems remain.
      if (rounds > 0 && (changes.patch === lastPatch || !found.length)) return undefined;
      rounds++;
      lastPatch = changes.patch;
      findings.push(...found);
      const what = changes.files.length ? `${changes.files.length} ${changes.files.length === 1 ? "file" : "files"} changed` : "no changes";
      const labels = found.map((f) => f.split(/[:(.]/)[0]!.trim());
      const note = `Self-review: ${what}, ${found.length ? `${found.length} to check (${labels.join("; ")})` : "nothing found automatically"}.`;
      return { message: reviewMessage(changes, found, fix, rounds), note, findings: found };
    },
  };
}

export type SelfReview = ReturnType<typeof createSelfReview>;
