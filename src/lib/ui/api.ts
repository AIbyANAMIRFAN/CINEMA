// Client-side JSON API helper. Errors from the API look like { error: { code, message, details }, requestId }.

export type ApiFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  details?: unknown;
};
export type ApiResult<T> = { ok: true; status: number; data: T } | ApiFailure;

export async function api<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, status: 0, code: "NETWORK", message: "Network error. Check your connection and try again." };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body
  }
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  return {
    ok: false,
    status: res.status,
    code: err?.code ?? (typeof (json as { error?: unknown })?.error === "string" ? String((json as { error: string }).error) : "HTTP_ERROR"),
    message: err?.message ?? `Request failed (${res.status}).`,
    details: err?.details,
  };
}

/** Map zod issues (details of a 400 BAD_REQUEST) to { field: message }. */
export function fieldErrors(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(details)) return out;
  for (const issue of details) {
    const path = (issue as { path?: unknown[] })?.path;
    const message = (issue as { message?: string })?.message;
    if (Array.isArray(path) && path.length && message) {
      const key = String(path[0]);
      out[key] ??= message;
    }
  }
  return out;
}
