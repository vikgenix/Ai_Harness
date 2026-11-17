import { ToolError, type Tool } from "./types.js";

/** The agent loop stops when this tool succeeds. */
export const FINISH_TOOL = "finish";

export interface FinishInput {
  outcome: "completed" | "blocked";
  summary: string;
}

export const finish: Tool<FinishInput> = {
  spec: {
    name: FINISH_TOOL,
    description:
      "End the task. Call it on its own (not together with other tools) once the task is done and checked, " +
      "or when you cannot complete it. The summary is shown to the user: say what you changed (files), " +
      "how you verified it (tests run and their result), and anything left open. Not needed for plain questions: just answer those.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["completed", "blocked"],
          description: "'completed' if the task is done and verified; 'blocked' if you could not finish it (say why in the summary).",
        },
        summary: { type: "string", description: "A few sentences: what changed, how it was verified, what is left." },
      },
      required: ["outcome", "summary"],
      additionalProperties: false,
    },
  },

  async run(input) {
    if (!input.summary.trim()) throw new ToolError("summary must not be empty");
    return "Task finished.";
  },
};
