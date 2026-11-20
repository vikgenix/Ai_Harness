import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../src/cli/args.js";

describe("parseCliArgs", () => {
  it("reads the run options", () => {
    expect(parseCliArgs(["--repo", "acme/demo", "--issue", "7", "--pr"])).toEqual({ repo: "acme/demo", issue: "7", task: undefined, pr: true, plain: false, config: undefined, check: false, ping: false, help: false });
    expect(parseCliArgs(["--task", "fix it"]).pr).toBe(false);
  });

  it("rejects unknown options", () => {
    expect(() => parseCliArgs(["--push"])).toThrow();
  });
});
