/** In dev, default ``""`` uses Vite ``/api`` proxy (see vite.config.ts). Set ``VITE_BACKEND_ORIGIN`` to hit Flask directly (cross‑origin). */
function resolveBackendOrigin(): string {
  const raw = (import.meta.env as any)?.VITE_BACKEND_ORIGIN as string | undefined;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    return String(raw).trim().replace(/\/+$/, "");
  }
  if (import.meta.env.DEV) return "";
  return "http://127.0.0.1:5000";
  // return "https://trading.investeria.in";
}

export const BACKEND_ORIGIN = resolveBackendOrigin();

/**
 * MD EventSource origin.
 * LAN Vite URL (http://192.168.x.x:5174) must NOT target 127.0.0.1 — browsers treat
 * that as a private-network jump and the stream dies; hunt LTP then freezes on REST.
 * Same-origin ``""`` uses the unbuffered ``/api/md/stream`` Vite proxy.
 */
export function getMdStreamOrigin(): string {
  const explicit = (import.meta.env as any)?.VITE_MD_STREAM_ORIGIN as string | undefined;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    return String(explicit).trim().replace(/\/+$/, "");
  }
  if (import.meta.env.DEV) {
    if (typeof window !== "undefined") {
      const host = window.location.hostname;
      if (host !== "localhost" && host !== "127.0.0.1") {
        return "";
      }
    }
    const proxyTarget = (import.meta.env as any)?.VITE_PROXY_TARGET as string | undefined;
    if (proxyTarget && String(proxyTarget).trim()) {
      return String(proxyTarget).trim().replace(/\/+$/, "");
    }
    return "http://127.0.0.1:5000";
  }
  return BACKEND_ORIGIN;
}

const AUTH_TOKEN_KEY = "sonofwind_auth_token";

export function getAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setAuthToken(token: string) {
  try {
    if (!token) localStorage.removeItem(AUTH_TOKEN_KEY);
    else localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // ignore
  }
  try {
    // Notify same-tab listeners (storage event doesn't fire in same tab).
    window.dispatchEvent(new Event("sonofwind_auth"));
  } catch {
    // ignore
  }
}

function networkErrorHint(err: unknown): Error {
  if (err instanceof TypeError || (err instanceof Error && /failed to fetch|networkerror|load failed/i.test(err.message))) {
    const hint =
      BACKEND_ORIGIN === ""
        ? `Backend reachable? Configure your API host (in dev, Vite can proxy \`/api\` to a target).`
        : `Cannot reach API at ${BACKEND_ORIGIN}.`;
    return new Error(`Failed to fetch — ${hint}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const token = getAuthToken();
  const noHttpCache =
    path.startsWith("/api/ix/") || path.startsWith("/api/margin");
  let res: Response;
  try {
    res = await fetch(`${BACKEND_ORIGIN}${path}`, {
      ...init,
      credentials: "include",
      cache: init.cache ?? (noHttpCache ? "no-store" : "default"),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {}),
      },
    });
  } catch (err) {
    throw networkErrorHint(err);
  }

  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await res.json() : await res.text();

  if (!res.ok) {
    let message =
      typeof body === "object" && body && "error" in body ? String((body as any).error) : `HTTP ${res.status}`;
    if (typeof body === "object" && body && "detail" in body && String((body as any).detail).trim()) {
      message = `${message}: ${String((body as any).detail)}`;
    } else if (typeof body === "string" && body.trim()) {
      const hint = body.trim().slice(0, 280);
      if (!message.includes(hint.slice(0, 20))) {
        message = `${message} — ${hint}`;
      }
    }
    if (res.status === 500 && BACKEND_ORIGIN === "" && import.meta.env.DEV) {
      message = `${message} (If your dev API isn't reachable, start it or set VITE_PROXY_TARGET in vite.config.)`;
    }
    throw new Error(message);
  }

  return body;
}

let mdStartInflight: Promise<void> | null = null;
let mdStartLastAt = 0;
const MD_START_MIN_MS = 10_000;

/** Debounced /api/md/start — avoids piling pending requests on Flask during load. */
export function mdStartOnce(opts?: { force?: boolean }): Promise<void> {
  const now = Date.now();
  const force = Boolean(opts?.force);
  if (mdStartInflight) return mdStartInflight;
  if (!force && now - mdStartLastAt < MD_START_MIN_MS) return Promise.resolve();
  mdStartLastAt = now;
  mdStartInflight = apiFetch("/api/md/start", { method: "POST" })
    .then(() => {
      try {
        window.dispatchEvent(new Event("sonofwind_md_resubscribe"));
      } catch {
        /* ignore */
      }
    })
    .catch(() => undefined)
    .finally(() => {
      mdStartInflight = null;
    });
  return mdStartInflight;
}

