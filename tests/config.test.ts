import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG_PATH, describeConfig, loadConfig } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "harness-config-"));
let n = 0;
function yamlFile(text: string): string {
  const p = join(dir, `c${n++}.yaml`);
  writeFileSync(p, text);
  return p;
}

const BASE = `
provider: auto
model: null
defaults:
  anthropic: claude-opus-5-5
  openai: gpt-5
  gemini: gemini-2.5-pro
  groq: openai/gpt-oss-120b
`;

describe("loadConfig", () => {
  it("loads the committed config/model.yaml", () => {
    const c = loadConfig({ env: { AI_API_KEY: "sk-ant-fake" } });
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-opus-5-5");
    expect(DEFAULT_CONFIG_PATH).toMatch(/config[\\/]model\.yaml$/);
  });

  it("fails clearly when AI_API_KEY is missing or blank", () => {
    const configPath = yamlFile(BASE);
    expect(() => loadConfig({ configPath, env: {} })).toThrow(ConfigError);
    expect(() => loadConfig({ configPath, env: { AI_API_KEY: "  " } })).toThrow(/AI_API_KEY is not set/);
  });

  it("detects the provider from the key and picks its default model", () => {
    const configPath = yamlFile(BASE);
    const c = loadConfig({ configPath, env: { AI_API_KEY: "gsk_fake" } });
    expect(c).toMatchObject({
      provider: "groq",
      providerSource: "key prefix",
      model: "openai/gpt-oss-120b",
      baseUrl: "https://api.groq.com/openai/v1",
    });
  });

  it("lets AI_PROVIDER / AI_MODEL / AI_BASE_URL override the file", () => {
    const configPath = yamlFile(BASE);
    const c = loadConfig({
      configPath,
      env: {
        AI_API_KEY: "local-key",
        AI_PROVIDER: "openai-compatible",
        AI_MODEL: "qwen3-coder",
        AI_BASE_URL: "http://localhost:11434/v1",
      },
    });
    expect(c).toMatchObject({
      provider: "openai-compatible",
      providerSource: "AI_PROVIDER",
      model: "qwen3-coder",
      baseUrl: "http://localhost:11434/v1",
    });
  });

  it("uses an explicit provider from the file over the key prefix", () => {
    const configPath = yamlFile(`${BASE}\nprovider: gemini\n`.replace("provider: auto\n", ""));
    const c = loadConfig({ configPath, env: { AI_API_KEY: "sk-fake" } });
    expect(c.provider).toBe("gemini");
    expect(c.providerSource).toBe("config file");
  });

  it("does not send temperature or seed to Anthropic, but does to others", () => {
    const configPath = yamlFile(BASE);
    const anthropic = loadConfig({ configPath, env: { AI_API_KEY: "sk-ant-fake" } });
    expect(anthropic.temperature).toBeUndefined();
    expect(anthropic.seed).toBeUndefined();
    const openai = loadConfig({ configPath, env: { AI_API_KEY: "sk-fake" } });
    expect(openai.temperature).toBe(0);
    expect(openai.seed).toBe(42);
  });

  it("rejects an unknown key format when provider is auto", () => {
    const configPath = yamlFile(BASE);
    expect(() => loadConfig({ configPath, env: { AI_API_KEY: "mystery" } })).toThrow(/Could not tell/);
  });

  it("rejects an unknown provider name", () => {
    const configPath = yamlFile(BASE);
    expect(() => loadConfig({ configPath, env: { AI_API_KEY: "sk-fake", AI_PROVIDER: "cohere" } })).toThrow(
      /Unknown provider 'cohere'/,
    );
  });

  it("requires a model and base URL for openai-compatible", () => {
    const configPath = yamlFile(BASE);
    expect(() =>
      loadConfig({ configPath, env: { AI_API_KEY: "k", AI_PROVIDER: "openai-compatible" } }),
    ).toThrow(/No model set/);
    expect(() =>
      loadConfig({ configPath, env: { AI_API_KEY: "k", AI_PROVIDER: "openai-compatible", AI_MODEL: "m" } }),
    ).toThrow(/needs a base URL/);
  });

  it("validates numeric limits", () => {
    const configPath = yamlFile(`${BASE}\nlimits:\n  max_steps: -1\n`);
    expect(() => loadConfig({ configPath, env: { AI_API_KEY: "sk-fake" } })).toThrow(/max_steps/);
  });

  it("reads effort, refusal_fallback and max_retries with defaults", () => {
    const defaults = loadConfig({ configPath: yamlFile(BASE), env: { AI_API_KEY: "sk-fake" } });
    expect(defaults).toMatchObject({ effort: undefined, refusalFallback: true, limits: { maxRetries: 3 } });

    const set = loadConfig({
      configPath: yamlFile(`${BASE}\neffort: xhigh\nrefusal_fallback: false\nlimits:\n  max_retries: 0\n`),
      env: { AI_API_KEY: "sk-fake" },
    });
    expect(set).toMatchObject({ effort: "xhigh", refusalFallback: false, limits: { maxRetries: 0 } });
  });

  it("reads repo_map_tokens: 3000 by default, 0 turns the map off", () => {
    expect(loadConfig({ configPath: yamlFile(BASE), env: { AI_API_KEY: "sk-fake" } }).repoMapTokens).toBe(3000);
    expect(loadConfig({ configPath: yamlFile(`${BASE}\nrepo_map_tokens: 0\n`), env: { AI_API_KEY: "sk-fake" } }).repoMapTokens).toBe(0);
    expect(() => loadConfig({ configPath: yamlFile(`${BASE}\nrepo_map_tokens: -5\n`), env: { AI_API_KEY: "sk-fake" } })).toThrow(/repo_map_tokens/);
  });

  it("reads self_review: on by default", () => {
    expect(loadConfig({ configPath: yamlFile(BASE), env: { AI_API_KEY: "sk-fake" } }).selfReview).toBe(true);
    expect(loadConfig({ configPath: yamlFile(`${BASE}\nself_review: false\n`), env: { AI_API_KEY: "sk-fake" } }).selfReview).toBe(false);
    expect(() => loadConfig({ configPath: yamlFile(`${BASE}\nself_review: maybe\n`), env: { AI_API_KEY: "sk-fake" } })).toThrow(/self_review/);
  });

  it("reads install_deps (on by default) and install_timeout_s", () => {
    expect(loadConfig({ configPath: yamlFile(BASE), env: { AI_API_KEY: "sk-fake" } })).toMatchObject({ installDeps: true, installTimeoutS: 600 });
    const off = loadConfig({ configPath: yamlFile(`${BASE}\ninstall_deps: false\ninstall_timeout_s: 120\n`), env: { AI_API_KEY: "sk-fake" } });
    expect(off).toMatchObject({ installDeps: false, installTimeoutS: 120 });
    expect(() => loadConfig({ configPath: yamlFile(`${BASE}\ninstall_deps: yes please\n`), env: { AI_API_KEY: "sk-fake" } })).toThrow(/install_deps/);
  });

  it("reads baseline_tests (on by default) and baseline_timeout_s", () => {
    expect(loadConfig({ configPath: yamlFile(BASE), env: { AI_API_KEY: "sk-fake" } })).toMatchObject({ baselineTests: true, baselineTimeoutS: 120 });
    const off = loadConfig({ configPath: yamlFile(`${BASE}\nbaseline_tests: false\nbaseline_timeout_s: 30\n`), env: { AI_API_KEY: "sk-fake" } });
    expect(off).toMatchObject({ baselineTests: false, baselineTimeoutS: 30 });
    expect(() => loadConfig({ configPath: yamlFile(`${BASE}\nbaseline_timeout_s: 1\n`), env: { AI_API_KEY: "sk-fake" } })).toThrow(/baseline_timeout_s/);
  });

  it("reads the sandbox: none by default, docker from the file or AI_SANDBOX", () => {
    expect(loadConfig({ configPath: yamlFile(BASE), env: { AI_API_KEY: "sk-fake" } })).toMatchObject({ sandbox: "none", sandboxImage: undefined, sandboxNetwork: true });
    const file = loadConfig({ configPath: yamlFile(`${BASE}\nsandbox: docker\nsandbox_image: python:3.11\nsandbox_network: false\n`), env: { AI_API_KEY: "sk-fake" } });
    expect(file).toMatchObject({ sandbox: "docker", sandboxImage: "python:3.11", sandboxNetwork: false });
    expect(describeConfig(file)).toContain("sandbox  : docker (python:3.11, network off)");
    expect(loadConfig({ configPath: yamlFile(BASE), env: { AI_API_KEY: "sk-fake", AI_SANDBOX: "docker" } }).sandbox).toBe("docker");
    expect(() => loadConfig({ configPath: yamlFile(BASE), env: { AI_API_KEY: "sk-fake", AI_SANDBOX: "podman" } })).toThrow(/'sandbox' \(or AI_SANDBOX\) must be one of: none, docker/);
  });

  it("reads pr_draft: on by default", () => {
    expect(loadConfig({ configPath: yamlFile(BASE), env: { AI_API_KEY: "sk-fake" } }).prDraft).toBe(true);
    expect(loadConfig({ configPath: yamlFile(`${BASE}\npr_draft: false\n`), env: { AI_API_KEY: "sk-fake" } }).prDraft).toBe(false);
    expect(() => loadConfig({ configPath: yamlFile(`${BASE}\npr_draft: maybe\n`), env: { AI_API_KEY: "sk-fake" } })).toThrow(/pr_draft/);
  });

  it("rejects an invalid effort", () => {
    const configPath = yamlFile(`${BASE}\neffort: extreme\n`);
    expect(() => loadConfig({ configPath, env: { AI_API_KEY: "sk-fake" } })).toThrow(/'effort' must be one of/);
  });

  it("reports a missing config file", () => {
    expect(() => loadConfig({ configPath: join(dir, "nope.yaml"), env: { AI_API_KEY: "sk-fake" } })).toThrow(
      /Config file not found/,
    );
  });
});

describe("describeConfig", () => {
  it("never includes the API key", () => {
    const key = "sk-ant-this-must-never-be-printed";
    const c = loadConfig({ configPath: yamlFile(BASE), env: { AI_API_KEY: key } });
    expect(describeConfig(c)).not.toContain(key);
    expect(describeConfig(c)).toContain("anthropic");
  });
});
