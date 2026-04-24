"use client";

import { useState } from "react";
import { useAuth } from "./auth-provider";

type SessionState = {
  label: string;
  detail: string;
  signedIn: boolean;
};

export function AppShellHeader() {
  const { status, user, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const session: SessionState = user
    ? { label: user.displayName || user.email, detail: user.role ? `${user.role} account` : "Signed in", signedIn: true }
    : status === "loading"
      ? { label: "Checking session", detail: "Loading", signedIn: false }
      : { label: "Not signed in", detail: "Login required", signedIn: false };

  async function handleLogout() {
    setBusy(true);
    try {
      await logout();
      window.location.href = "/login";
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="topbar" aria-label="Account and session">
      <div>
        <div className="topbar__label">Session</div>
        <div className="topbar__user">{session.label}</div>
        <div className="muted topbar__detail">{session.detail}</div>
      </div>
      <div className="topbar__actions">
        <a className="button button--ghost" href="/login">Login</a>
        <button className="button" type="button" onClick={handleLogout} disabled={busy || !session.signedIn} aria-label="Sign out of PacketChat">
          {busy ? "Signing out..." : "Logout"}
        </button>
      </div>
    </header>
  );
}
