import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveInRoot } from "./paths.js";
import { ToolError, type Tool } from "./types.js";

/** Largest file the agent may create; source files are far smaller. */
export const MAX_CREATE_BYTES = 1024 * 1024;

interface CreateFileInput {
  path: string;
  content: string;
}

export const createFile: Tool<CreateFileInput> = {
  spec: {
    name: "create_file",
    description:
      "Create a new file with the given content. Missing parent directories are created. " +
      "Fails if the file already exists: use edit_file to change existing files. " +
      "Files starting with '#!' are made executable.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the new file, relative to the repository root." },
        content: { type: "string", description: "Full content of the file. End it with a newline." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },

  async run(input, ctx) {
    const { absolute, display } = await resolveInRoot(ctx.root, input.path);
    if (display === "." || input.path.endsWith("/")) throw new ToolError("path must name a file, not a directory");
    if (display.split("/").includes(".git")) throw new ToolError("files inside .git cannot be created");
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > MAX_CREATE_BYTES) throw new ToolError(`content is too large (${(bytes / 1024 / 1024).toFixed(1)} MB, max 1 MB)`);

    const existing = await stat(absolute).catch(() => null);
    if (existing?.isDirectory()) throw new ToolError(`${display} is a directory`);
    if (existing) throw new ToolError(`${display} already exists; use edit_file to change it`);

    const dir = path.dirname(absolute);
    const dirInfo = await stat(dir).catch(() => null);
    if (dirInfo && !dirInfo.isDirectory()) throw new ToolError(`cannot create ${display}: ${path.posix.dirname(display)} is a file`);
    let madeDirs = "";
    if (!dirInfo) {
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        throw new ToolError(`cannot create ${display}: a parent path is a file`);
      }
      madeDirs = `, created directory ${path.posix.dirname(display)}/`;
    }

    if (ctx.signal?.aborted) throw new ToolError("create cancelled");
    try {
      // "wx" fails if the file appeared in the meantime, so nothing is ever overwritten.
      await writeFile(absolute, input.content, { encoding: "utf8", flag: "wx", mode: input.content.startsWith("#!") ? 0o755 : 0o644 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new ToolError(`${display} already exists; use edit_file to change it`);
      throw err;
    }

    const lines = input.content === "" ? 0 : input.content.split("\n").length - (input.content.endsWith("\n") ? 1 : 0);
    const notes = [`${lines} ${lines === 1 ? "line" : "lines"}`, `${bytes} bytes`];
    if (input.content && !input.content.endsWith("\n")) notes.push("no newline at end");
    return `Created ${display} (${notes.join(", ")}${madeDirs}).`;
  },
};
