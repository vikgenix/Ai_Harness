import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  DEFAULT_BASE_URLS,
  PROVIDERS,
  SUPPORTS_SEED,
  SUPPORTS_TEMPERATURE,
  detectProviderFromKey,
  isProvider,
  type Provider,
} from "./providers.js";

/** Works from both src/ (tests) and dist/ (built), since both sit next to config/. */
export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../config/model.yaml", import.meta.url));

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface HarnessConfig {
  provider: Provider;
  /** Where the provider choice came from, shown to the user for transparency. */
  providerSource: "AI_PROVIDER" | "config file" | "key prefix";
  model: string;
  baseUrl: string;
  /** Never print this. Use describeConfig() for display. */
  apiKey: string;
  maxOutputTokens: number;
  /** undefined when the provider does not accept the setting. */
  temperature: number | undefined;
  seed: number | undefined;
  limits: {
    maxSteps: number;
    maxCostUsd: number;
    requestTimeoutS: number;
  };
}

type Env = Record<string, string | undefined>;

export interface LoadOptions {
  configPath?: string;
  env?: Env;
}

export function loadConfig(opts: LoadOptions = {}): HarnessConfig {
  const env = opts.env ?? process.env;
  const path = opts.configPath ?? DEFAULT_CONFIG_PATH;
  const file = readYaml(path);

  const apiKey = (env.AI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new ConfigError(
      'AI_API_KEY is not set. Run: export AI_API_KEY="<your key>"  (it is never stored in the repo)',
    );
  }

  // Provider: AI_PROVIDER env > config file > key prefix.
  const fileProvider = optionalString(file, "provider") ?? "auto";
  const envProvider = blankToUndefined(env.AI_PROVIDER);
  const detected = detectProviderFromKey(apiKey);

  let provider: Provider;
  let providerSource: HarnessConfig["providerSource"];
  if (envProvider) {
    provider = requireProvider(envProvider, "AI_PROVIDER");
    providerSource = "AI_PROVIDER";
  } else if (fileProvider !== "auto") {
    provider = requireProvider(fileProvider, `provider in ${path}`);
    providerSource = "config file";
  } else if (detected) {
    provider = detected.provider;
    providerSource = "key prefix";
  } else {
    throw new ConfigError(
      "Could not tell which provider AI_API_KEY belongs to. " +
        `Set AI_PROVIDER or 'provider' in ${path} to one of: ${PROVIDERS.join(", ")}`,
    );
  }

  // Model: AI_MODEL env > config `model` > config `defaults[provider]`.
  const defaults = optionalObject(file, "defaults") ?? {};
  const model =
    blankToUndefined(env.AI_MODEL) ?? optionalString(file, "model") ?? optionalString(defaults, provider);
  if (!model) {
    throw new ConfigError(`No model set for provider '${provider}'. Set AI_MODEL or 'model' in ${path}.`);
  }

  // Base URL: AI_BASE_URL env > config `base_url` > detected (OpenRouter) > built-in default.
  const detectedBaseUrl = detected?.provider === provider ? detected.baseUrl : undefined;
  const baseUrl =
    blankToUndefined(env.AI_BASE_URL) ??
    optionalString(file, "base_url") ??
    detectedBaseUrl ??
    DEFAULT_BASE_URLS[provider];
  if (!baseUrl) {
    throw new ConfigError(`Provider '${provider}' needs a base URL. Set AI_BASE_URL or 'base_url' in ${path}.`);
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new ConfigError(`base_url is not a valid URL: ${baseUrl}`);
  }

  const limits = optionalObject(file, "limits") ?? {};
  const temperature = optionalNumber(file, "temperature", 0, 2) ?? 0;
  const seed = optionalNumber(file, "seed", 0, Number.MAX_SAFE_INTEGER) ?? 42;

  return {
    provider,
    providerSource,
    model,
    baseUrl,
    apiKey,
    maxOutputTokens: optionalNumber(file, "max_output_tokens", 1, 1_000_000) ?? 16000,
    temperature: SUPPORTS_TEMPERATURE[provider] ? temperature : undefined,
    seed: SUPPORTS_SEED[provider] ? seed : undefined,
    limits: {
      maxSteps: optionalNumber(limits, "max_steps", 1, 10_000) ?? 60,
      maxCostUsd: optionalNumber(limits, "max_cost_usd", 0.01, 10_000) ?? 2,
      requestTimeoutS: optionalNumber(limits, "request_timeout_s", 1, 3600) ?? 300,
    },
  };
}

/** A printable summary that never includes the API key. */
export function describeConfig(c: HarnessConfig): string {
  return [
    `provider : ${c.provider} (from ${c.providerSource})`,
    `model    : ${c.model}`,
    `endpoint : ${c.baseUrl}`,
    `limits   : ${c.limits.maxSteps} steps, $${c.limits.maxCostUsd.toFixed(2)} per task`,
  ].join("\n");
}

// --- small validation helpers -------------------------------------------------

type Obj = Record<string, unknown>;

function readYaml(path: string): Obj {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`Config file not found: ${path}`);
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    throw new ConfigError(`Config file ${path} is not valid YAML: ${(e as Error).message}`);
  }
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigError(`Config file ${path} must be a YAML mapping.`);
  }
  return data as Obj;
}

function blankToUndefined(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function requireProvider(value: string, where: string): Provider {
  if (!isProvider(value)) {
    throw new ConfigError(`Unknown provider '${value}' in ${where}. Use one of: ${PROVIDERS.join(", ")}`);
  }
  return value;
}

function optionalString(o: Obj, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ConfigError(`'${key}' must be a string.`);
  return blankToUndefined(v);
}

function optionalNumber(o: Obj, key: string, min: number, max: number): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || Number.isNaN(v) || v < min || v > max) {
    throw new ConfigError(`'${key}' must be a number between ${min} and ${max}.`);
  }
  return v;
}

function optionalObject(o: Obj, key: string): Obj | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`'${key}' must be a mapping.`);
  return v as Obj;
}
