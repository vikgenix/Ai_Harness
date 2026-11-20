import { GITHUB_API, GitHubError } from "./issues.js";

/** How to reach the GitHub REST API. The token is optional for reading public repositories. */
export interface ApiOptions {
  token?: string;
  signal?: AbortSignal;
  /** For tests. */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export interface ApiResponse {
  status: number;
  data: Record<string, unknown> & { message?: string; errors?: { message?: string }[] };
  /** For list endpoints, the array itself. */
  list: Record<string, unknown>[];
  headers: Headers;
}

/** One GitHub REST call. Throws GitHubError for network problems and a rejected token; other statuses are for the caller. */
export async function githubApi(opts: ApiOptions, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${opts.apiBase ?? GITHUB_API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "shrike",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new GitHubError("Cancelled.");
    throw new GitHubError(`Could not reach GitHub: ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (res.status === 401) throw new GitHubError("GitHub rejected GITHUB_TOKEN (401). Check that it is valid and not expired.");
  return {
    status: res.status,
    data: (Array.isArray(json) ? {} : (json ?? {})) as ApiResponse["data"],
    list: Array.isArray(json) ? (json as Record<string, unknown>[]) : [],
    headers: res.headers,
  };
}

/** GitHub's error message, with its details. */
export function apiMessage(r: ApiResponse): string {
  return [r.data.message, ...(r.data.errors ?? []).map((e) => e.message)].filter(Boolean).join(": ");
}

/** True when a 403/429 is GitHub's rate limit rather than a permission problem. */
export function rateLimited(r: ApiResponse): boolean {
  return r.status === 429 || (r.status === 403 && (r.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(r.data.message ?? "")));
}
