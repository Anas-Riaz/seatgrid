import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage, type Session } from "../api";

/** Compact login / register form. While registering, the username is checked live (constant-time lookup). */
export function AccountPanel({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("demo");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("password123");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setAvailable(null);
    if (mode !== "register" || username.trim().length < 3) return;
    const timer = setTimeout(() => {
      api<{ available: boolean }>(`/auth/username-available?username=${encodeURIComponent(username)}`)
        .then((r) => setAvailable(r.available))
        .catch(() => setAvailable(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [mode, username]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (mode === "register") {
        await api("/auth/register", { method: "POST", body: { username, email, password } });
      }
      const session = await api<Session>("/auth/login", { method: "POST", body: { username, password } });
      onSignedIn(session);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form className="account-form" onSubmit={submit}>
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
      {mode === "register" && (
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" type="email" />
      )}
      <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" type="password" />
      <button type="submit">{mode === "login" ? "Log in" : "Register"}</button>
      <button type="button" className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? "New here?" : "Have an account?"}
      </button>
      {available !== null && <span className={available ? "ok" : "error"}>{available ? "available" : "taken"}</span>}
      {error && <span className="error">{error}</span>}
    </form>
  );
}
