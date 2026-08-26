"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "../../components/auth-provider";
import { useToast } from "../../components/ui";
import { acceptInvite, completePasswordReset } from "../../lib/auth-client";

type Status = {
  tone: "success" | "error" | "info";
  message: string;
};

export function LoginClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useAuth();
  const toast = useToast();
  const inviteToken = searchParams.get("invite");
  const resetToken = searchParams.get("reset");
  const nextPath = safeNextPath(searchParams.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const mode = inviteToken ? "invite" : resetToken ? "reset" : "login";
  const destination = nextPath ?? "/";

  useEffect(() => {
    if (mode !== "login") return;
    if (auth.status === "authenticated") router.replace(destination);
  }, [auth.status, destination, mode, router]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setStatus(null);

    try {
      const result = await auth.login(email, password);
      const name = result.user?.displayName || result.user?.email || "your account";
      setStatus({ tone: "success", message: result.warning ? `${result.warning} Signed in as ${name}.` : `Signed in as ${name}.` });
      try {
        window.localStorage.setItem("packetchat.lastLoginAt", String(Date.now()));
      } catch {
        /* ignore storage errors */
      }
      router.replace(destination);
    } catch (error) {
      setStatus({ tone: "error", message: error instanceof Error ? error.message : "Sign in failed" });
    } finally {
      setLoading(false);
    }
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inviteToken) return;
    if (password !== confirmPassword) {
      setStatus({ tone: "error", message: "Passwords do not match." });
      return;
    }

    setLoading(true);
    setStatus(null);

    try {
      await acceptInvite(inviteToken, displayName, password);
      setStatus({ tone: "success", message: "Invite accepted. You can sign in now." });
      setPassword("");
      setConfirmPassword("");
    } catch (error) {
      setStatus({ tone: "error", message: error instanceof Error ? error.message : "Invite acceptance failed" });
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetToken) return;
    if (password !== confirmPassword) {
      setStatus({ tone: "error", message: "Passwords do not match." });
      return;
    }

    setLoading(true);
    setStatus(null);

    try {
      await completePasswordReset(resetToken, password);
      setStatus({ tone: "success", message: "Password reset complete. You can sign in now." });
      setPassword("");
      setConfirmPassword("");
    } catch (error) {
      setStatus({ tone: "error", message: error instanceof Error ? error.message : "Password reset failed" });
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    setLoading(true);
    setStatus(null);

    try {
      const user = await auth.refresh();
      setStatus({ tone: "success", message: `Session refreshed for ${user?.displayName || user?.email || "your account"}.` });
    } catch (error) {
      setStatus({ tone: "error", message: error instanceof Error ? error.message : "Refresh failed" });
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    setLoading(true);
    setStatus(null);

    try {
      await auth.logout();
      setStatus({ tone: "success", message: "Signed out. Local session storage and refresh cookie were cleared." });
    } catch (error) {
      setStatus({ tone: "error", message: error instanceof Error ? error.message : "Sign out failed" });
    } finally {
      setLoading(false);
    }
  }

  function handleForgotPassword() {
    toast({
      variant: "info",
      title: "Forgot password",
      message: "Ask your admin for a reset link — self-serve reset isn't available in this release"
    });
  }

  const submitDisabled = loading;

  return (
    <section className="card auth-card">
      <div className="eyebrow">{mode === "invite" ? "Invite" : mode === "reset" ? "Password reset" : "Login"}</div>
      <h1>{mode === "invite" ? "Accept your PacketChat invite" : mode === "reset" ? "Choose a new password" : "Sign in to PacketChat"}</h1>
      <p className="muted">
        {mode === "invite"
          ? "Create your account password to finish accepting this invite."
          : mode === "reset"
            ? "Set a new password for your account. Existing sessions will be revoked."
            : "Use your PacketChat account credentials."}
      </p>

      {mode === "invite" ? (
        <form className="auth-form" onSubmit={handleInvite}>
          <label htmlFor="displayName">Display name</label>
          <input id="displayName" className="input" type="text" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" />
          <label htmlFor="invitePassword">Password</label>
          <input id="invitePassword" className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} />
          <label htmlFor="inviteConfirmPassword">Confirm password</label>
          <input id="inviteConfirmPassword" className="input" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={8} />
          <button className="button" type="submit" disabled={loading}>{loading ? "Accepting..." : "Accept invite"}</button>
        </form>
      ) : mode === "reset" ? (
        <form className="auth-form" onSubmit={handleReset}>
          <label htmlFor="resetPassword">New password</label>
          <input id="resetPassword" className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} />
          <label htmlFor="resetConfirmPassword">Confirm new password</label>
          <input id="resetConfirmPassword" className="input" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={8} />
          <button className="button" type="submit" disabled={loading}>{loading ? "Saving..." : "Reset password"}</button>
        </form>
      ) : (
        <form className="auth-form" onSubmit={handleLogin}>
          <label htmlFor="email">Email</label>
          <input id="email" className="input" type="email" name="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required />
          <label htmlFor="password">Password</label>
          <input id="password" className="input" type="password" name="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <button className="button" type="submit" disabled={submitDisabled}>
            {loading ? "Signing in..." : "Sign in"}
          </button>
          <button className="link-button" type="button" onClick={handleForgotPassword}>
            Forgot password?
          </button>
        </form>
      )}

      {status ? <p className={`auth-status ${status.tone}`}>{status.message}</p> : null}

      {mode === "login" ? (
        <div className="auth-actions">
          <button className="link-button" type="button" onClick={handleRefresh} disabled={loading}>Refresh session and load profile</button>
          <button className="link-button" type="button" onClick={handleLogout} disabled={loading}>Sign out and clear this browser</button>
        </div>
      ) : null}
    </section>
  );
}

function safeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login/")) return null;
  return value;
}
