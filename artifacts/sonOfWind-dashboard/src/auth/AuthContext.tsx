import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch, setAuthToken } from "@/lib/backend";

type AuthState =
  | { status: "loading"; username: null }
  | { status: "anon"; username: null }
  | { status: "authed"; username: string };

type AuthContextValue = {
  state: AuthState;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading", username: null });

  const refresh = useCallback(async () => {
    setState(s => (s.status === "loading" ? s : { status: "loading", username: null }));
    try {
      const me = (await apiFetch("/api/auth/me")) as { loggedIn: boolean; username?: string | null };
      if (me.loggedIn && me.username) setState({ status: "authed", username: String(me.username) });
      else setState({ status: "anon", username: null });
    } catch {
      setState({ status: "anon", username: null });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const r = (await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    })) as { ok?: boolean; username?: string; token?: string; error?: string };

    if (r.ok && r.username) {
      setAuthToken(r.token || "");
      setState({ status: "authed", username: r.username });
      return;
    }
    setAuthToken("");
    setState({ status: "anon", username: null });
    throw new Error(r.error || "Invalid username or password");
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } finally {
      setAuthToken("");
      setState({ status: "anon", username: null });
    }
  }, []);

  const value = useMemo<AuthContextValue>(() => ({ state, refresh, login, logout }), [state, refresh, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used within AuthProvider");
  return v;
}

