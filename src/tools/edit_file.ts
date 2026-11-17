import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveInRoot } from "./paths.js";
import { ToolError, type Tool } from "./types.js";

/** Files bigger than this are not edited (generated or data files). */
export const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;
/** Lines of unchanged code shown around an edit. */
const SNIPPET_CONTEXT = 3;
/** Longest snippet returned after an edit. */
const MAX_SNIPPET_LINES = 40;
/** Line numbers listed when old_string is ambiguous. */
const MAX_LISTED = 10;

interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const editFile: Tool<EditFileInput> = {
  spec: {
    name: "edit_file",
    description:
      "Edit an existing file by replacing exact text. old_string must match the file exactly, including indentation " +
      "and line breaks (copy it from view_file output without the line-number prefixes), and must be unique in the file: " +
      "include a few surrounding lines to make it unique, or set replace_all to change every occurrence. " +
      "To delete code, use an empty new_string. Returns the edited lines with their new line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the repository root." },
        old_string: { type: "string", description: "Exact text to replace. Must not be empty." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one. Default false." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },

  async run(input, ctx) {
    const { absolute, display } = await resolveInRoot(ctx.root, input.path);
    if (display.split("/").includes(".git")) throw new ToolError("files inside .git cannot be edited");
    if (input.old_string === "") throw new ToolError("old_string must not be empty; it says which text to replace");
    if (input.old_string === input.new_string) throw new ToolError("old_string and new_string are the same; nothing to change");

    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new ToolError(`file not found: ${display} (edit_file only changes existing files)`);
    }
    if (!info.isFile()) throw new ToolError(`${display} is not a file`);
    if (info.size > MAX_EDIT_FILE_BYTES) throw new ToolError(`${display} is too large to edit (${(info.size / 1024 / 1024).toFixed(1)} MB)`);

    const buffer = await readFile(absolute);
    if (buffer.subarray(0, 8192).includes(0)) throw new ToolError(`${display} is a binary file and cannot be edited`);
    const content = buffer.toString("utf8");

    // Models write "\n"; keep a CRLF file CRLF.
    const crlf = content.includes("\r\n") && !input.old_string.includes("\r");
    const oldText = crlf ? input.old_string.replace(/\n/g, "\r\n") : input.old_string;
    const newText = crlf ? input.new_string.replace(/\n/g, "\r\n") : input.new_string;

    const positions = occurrences(content, oldText);
    if (positions.length === 0) throw new ToolError(notFoundMessage(content, input.old_string, display));
    if (positions.length > 1 && !input.replace_all) {
      const lines = positions.slice(0, MAX_LISTED).map((p) => lineAt(content, p));
      const more = positions.length > MAX_LISTED ? ", ..." : "";
      throw new ToolError(
        `old_string occurs ${positions.length} times in ${display} (lines ${lines.join(", ")}${more}). ` +
          "Include more surrounding lines to make it unique, or set replace_all=true to change all of them.",
      );
    }

    // Build the new content and remember where each replacement landed.
    let updated = "";
    let last = 0;
    const placed: number[] = [];
    for (const p of positions) {
      updated += content.slice(last, p);
      placed.push(updated.length);
      updated += newText;
      last = p + oldText.length;
    }
    updated += content.slice(last);

    if (ctx.signal?.aborted) throw new ToolError("edit cancelled");
    await writeAtomically(await realpath(absolute), updated, info.mode);

    const count = positions.length === 1 ? "1 occurrence" : `${positions.length} occurrences`;
    const snippet = showEdit(updated, placed[0]!, newText);
    const others = placed.length > 1 ? `\n(other replacements at lines ${placed.slice(1, MAX_LISTED + 1).map((p) => lineAt(updated, p)).join(", ")}${placed.length > MAX_LISTED + 1 ? ", ..." : ""})` : "";
    return `Edited ${display}: replaced ${count}.\n${snippet}${others}`;
  },
};

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) found.push(i);
  return found;
}

/** 1-based line number of a character offset. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

const splitLines = (text: string) => text.split(/\r?\n/);

/** Explains why old_string was not found, with a hint when the cause is common. */
function notFoundMessage(content: string, oldString: string, display: string): string {
  const base = `old_string was not found in ${display}.`;
  const oldLines = splitLines(oldString);

  if (oldLines.every((l) => l === "" || /^\s*\d+\t/.test(l)) && oldLines.some((l) => /^\s*\d+\t/.test(l))) {
    return `${base} It starts with line numbers from view_file; remove the "N<tab>" prefixes and try again.`;
  }

  // Same lines apart from indentation or trailing spaces?
  const trimmed = oldLines.map((l) => l.trim());
  while (trimmed.length && trimmed[0] === "") trimmed.shift();
  while (trimmed.length && trimmed[trimmed.length - 1] === "") trimmed.pop();
  if (trimmed.length) {
    const fileLines = splitLines(content).map((l) => l.trim());
    const near: number[] = [];
    for (let i = 0; i + trimmed.length <= fileLines.length && near.length < MAX_LISTED; i++) {
      if (trimmed.every((t, j) => fileLines[i + j] === t)) near.push(i + 1);
    }
    if (near.length) {
      return `${base} The same text exists with different whitespace or indentation at line ${near.join(", ")}. View those lines and copy them exactly.`;
    }
  }
  return `${base} View the file to see its current content, then copy the text exactly.`;
}

/** The edited region with a few lines of context, numbered like view_file. */
function showEdit(updated: string, offset: number, newText: string): string {
  const lines = splitLines(updated);
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return "(the file is now empty)";
  const first = lineAt(updated, offset);
  const changed = newText === "" ? 0 : splitLines(newText).length - 1;
  const from = Math.max(1, first - SNIPPET_CONTEXT);
  const to = Math.min(lines.length, first + changed + SNIPPET_CONTEXT, from + MAX_SNIPPET_LINES - 1);
  const width = String(to).length;
  const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(width)}\t${l}`);
  return body.join("\n");
}

/** Writes via a temporary file and rename, so an interrupted write never leaves a half-written file. */
async function writeAtomically(file: string, content: string, mode: number): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.harness-${process.pid}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await chmod(tmp, mode & 0o7777);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
