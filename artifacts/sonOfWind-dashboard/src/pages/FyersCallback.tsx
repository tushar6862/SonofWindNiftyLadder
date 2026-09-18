import { useEffect, useState } from "react";
import { Redirect, useSearch } from "wouter";
import { apiFetch, getAuthToken } from "@/lib/backend";

/** Fyers OAuth redirect target — exchanges ?auth_code= for daily access_token. */
export default function FyersCallbackPage() {
  const search = useSearch();
  const [msg, setMsg] = useState("Fyers login…");
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
    const code = (params.get("auth_code") || params.get("code") || "").trim();
    if (!code) {
      setErr("auth_code missing — Fyers login dubara try karo");
      return;
    }
    if (!getAuthToken()) {
      setErr("Pehle SonOfWind login karo, phir Fyers connect");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = (await apiFetch("/api/fyers/callback", {
          method: "POST",
          body: JSON.stringify({ auth_code: code }),
        })) as { ok?: boolean; error?: string; message?: string };
        if (cancelled) return;
        if (!res?.ok) {
          setErr(String(res?.error || "Fyers token fail"));
          return;
        }
        setMsg(res.message || "Fyers LTP connected");
        setDone(true);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [search]);

  if (done) {
    return <Redirect to="/" />;
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <div className="text-lg font-medium">{err ? "Fyers login failed" : msg}</div>
        {err ? <div className="text-sm text-destructive">{err}</div> : null}
        {err ? (
          <a href="/" className="text-sm underline opacity-80">
            Dashboard pe wapas
          </a>
        ) : (
          <div className="text-sm opacity-60">Redirecting…</div>
        )}
      </div>
    </div>
  );
}
