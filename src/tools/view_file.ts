import { readFile, stat } from "node:fs/promises";
import { resolveInRoot } from "./paths.js";
import { ToolError, type Tool } from "./types.js";

/** Lines shown per call when no range is given; keeps token use predictable. */
export const DEFAULT_MAX_LINES = 400;
/** Hard limit per call, even with an explicit range. */
export const MAX_LINES = 1000;
/** Longer lines (minified code, data) are cut. */
export const MAX_LINE_CHARS = 1000;
/** Files bigger than this are not read at all. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface ViewFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

export const viewFile: Tool<ViewFileInput> = {
  spec: {
    name: "view_file",
    description:
      "Read a text file in the repository. Returns the lines prefixed with their line numbers (number, tab, text). " +
      `Shows at most ${DEFAULT_MAX_LINES} lines unless a range is given (max ${MAX_LINES} per call); ` +
      "the footer says how to read further. Use a line range for large files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the repository root." },
        start_line: { type: "integer", minimum: 1, description: "First line to show (1-based). Default 1." },
        end_line: { type: "integer", minimum: 1, description: "Last line to show (inclusive)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },

  async run(input, ctx) {
    const { absolute, display } = await resolveInRoot(ctx.root, input.path);

    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new ToolError(`file not found: ${display}`);
    }
    if (info.isDirectory()) throw new ToolError(`${display} is a directory, not a file`);
    if (info.size > MAX_FILE_BYTES) {
      throw new ToolError(`${display} is too large to read (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
    }

    const buffer = await readFile(absolute);
    if (buffer.length === 0) return `${display}: (empty file)`;
    if (buffer.subarray(0, 8192).includes(0)) return `${display}: binary file (${buffer.length.toLocaleString("en-US")} bytes), not shown`;

    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop(); // trailing newline is not an extra line
    const total = lines.length;

    const start = input.start_line ?? 1;
    if (start > total) throw new ToolError(`start_line ${start} is past the end of ${display} (${total} lines)`);
    if (input.end_line !== undefined && input.end_line < start) {
      throw new ToolError(`end_line (${input.end_line}) is before start_line (${start})`);
    }
    const limit = input.end_line === undefined ? DEFAULT_MAX_LINES : MAX_LINES;
    const end = Math.min(input.end_line ?? total, total, start + limit - 1);

    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => {
        const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line cut, ${line.length} chars]` : line;
        return `${String(start + i).padStart(width)}\t${shown}`;
      })
      .join("\n");

    const footer =
      end < total
        ? `\n(${display}: lines ${start}-${end} of ${total}. To read more, call view_file with start_line=${end + 1}.)`
        : start > 1
          ? `\n(${display}: lines ${start}-${end} of ${total}.)`
          : "";
    return body + footer;
  },
};

