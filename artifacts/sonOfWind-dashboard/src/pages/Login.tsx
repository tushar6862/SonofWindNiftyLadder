import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/auth/AuthContext";
import { Eye, EyeOff } from "lucide-react";

const UKEY = "sonofwind_login_user";
const PKEY = "sonofwind_login_pass";

export default function LoginPage() {
  const [, navigate] = useLocation();
  const { state, login } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const initial = useMemo(() => {
    const u = (localStorage.getItem(UKEY) || "").trim();
    const p = localStorage.getItem(PKEY) || "";
    return { u, p };
  }, []);

  const [username, setUsername] = useState(initial.u);
  const [password, setPassword] = useState(initial.p);
  const [showPass, setShowPass] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (state.status === "authed") navigate("/");
  }, [state.status, navigate]);

  useEffect(() => {
    localStorage.setItem(UKEY, username || "");
  }, [username]);

  useEffect(() => {
    localStorage.setItem(PKEY, password || "");
  }, [password]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  const loginBgUrl = `${import.meta.env.BASE_URL}login-bg.png`.replace(/\/{2,}/g, "/");

  return (
    <div className="sow-login-bg min-h-screen w-full relative overflow-hidden bg-black text-foreground px-4">
      <img src={loginBgUrl} alt="" className="sow-login-bg__image" aria-hidden draggable={false} />
      <div className="sow-login-bg__overlay" aria-hidden />

      <div className="relative z-10 min-h-screen w-full flex items-center justify-end p-6 sm:p-8">
        <div className="sow-login-glass w-full max-w-sm p-8">
          <div className="relative text-center mb-8">
            <div className="sow-login-glass__title text-[20px] font-extrabold tracking-[0.22em]">SONOFWIND</div>
            <div className="sow-login-glass__subtitle text-[10px] tracking-[0.35em] mt-0.5 uppercase">Nifty Ladder Login</div>
          </div>

          {error && (
            <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} className="relative space-y-4">
            <div className="space-y-1.5">
              <label className="sow-login-glass__label text-[10px] tracking-widest uppercase">Username</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="sow-login-glass__input w-full rounded-lg px-3 py-2.5 text-sm transition-shadow"
                placeholder="SR04 / ADMIN"
                autoFocus
                autoComplete="off"
                style={{ textTransform: "uppercase" }}
              />
            </div>

            <div className="space-y-1.5">
              <label className="sow-login-glass__label text-[10px] tracking-widest uppercase">Password</label>
              <div className="relative">
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type={showPass ? "text" : "password"}
                  className="sow-login-glass__input w-full rounded-lg pl-3 pr-10 py-2.5 text-sm transition-shadow"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPass((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md cursor-pointer text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                  aria-label={showPass ? "Hide password" : "Show password"}
                >
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              disabled={submitting}
              className="sow-login-btn w-full rounded-lg font-extrabold py-2.5 text-sm tracking-widest cursor-pointer"
              type="submit"
            >
              {submitting ? "LOGGING IN..." : "LOGIN →"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

