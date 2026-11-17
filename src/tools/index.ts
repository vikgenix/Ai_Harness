import { listDir } from "./list_dir.js";
import { ToolRegistry } from "./registry.js";
import { viewFile } from "./view_file.js";

export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext } from "./types.js";

/** The tools the agent gets. New tools are added here, one at a time. */
export function createDefaultTools(): ToolRegistry {
  return new ToolRegistry([viewFile, listDir]);
}
