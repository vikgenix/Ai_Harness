import { bash } from "./bash.js";
import { createFile } from "./create_file.js";
import { editFile } from "./edit_file.js";
import { findFiles } from "./find_files.js";
import { finish } from "./finish.js";
import { listDir } from "./list_dir.js";
import { ToolRegistry } from "./registry.js";
import { grep } from "./grep.js";
import { viewFile } from "./view_file.js";

export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext } from "./types.js";

/** The tools the agent gets. New tools are added here, one at a time. */
export function createDefaultTools(): ToolRegistry {
  return new ToolRegistry([viewFile, listDir, grep, findFiles, editFile, createFile, bash, finish]);
}
