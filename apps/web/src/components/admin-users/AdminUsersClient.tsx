"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { authFetch } from "../../lib/auth-client";
import { LoadingBlock, StatusBadge } from "../ui";

type AdminUser = {
  id: string;
  email: string;
  display_name: string | null;
  role: "admin" | "user" | string;
  status: string;
  byok_enabled: boolean;
  is_break_glass: boolean;
  created_at: string;
  last_login_at: string | null;
};

type GeneratedLink = {
  label: string;
  email: string;
  url: string;
  delivery?: EmailDelivery;
};

type EmailDelivery = {
  provider: string;
  status: string;
  message?: string;
};

type ApiError = {
  error?: {
    message?: string;
  };
};

async function parseResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & ApiError;
  if (!response.ok) {
    throw new Error(data.error?.message ?? `Request failed with ${response.status}`);
  }
  return data;
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatDelivery(delivery: EmailDelivery) {
  if (delivery.status === "sent") return `${delivery.provider} sent`;
  if (delivery.status === "failed") return `${delivery.provider} failed${delivery.message ? ` (${delivery.message})` : ""}; manual URL available`;
  return "manual URL available";
}

export function AdminUsersClient() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<GeneratedLink[]>([]);
  const [mode, setMode] = useState<"invite" | "direct">("invite");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [password, setPassword] = useState("");
  const [forceReset, setForceReset] = useState(true);
  const [byokEnabled, setByokEnabled] = useState(false);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [byokFilter, setByokFilter] = useState("all");

  const filteredUsers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return users.filter((user) => {
      const matchesQuery = !needle || [user.email, user.display_name, user.role, user.status].some((value) => value?.toLowerCase().includes(needle));
      const matchesRole = roleFilter === "all" || user.role === roleFilter;
      const matchesByok = byokFilter === "all" || (byokFilter === "enabled" ? user.byok_enabled : !user.byok_enabled);
      return matchesQuery && matchesRole && matchesByok;
    });
  }, [byokFilter, query, roleFilter, users]);

  const stats = useMemo(() => ({
    total: users.length,
    admins: users.filter((user) => user.role === "admin").length,
    byok: users.filter((user) => user.byok_enabled).length,
    breakGlass: users.filter((user) => user.is_break_glass).length
  }), [users]);

  async function loadUsers() {
    setLoading(true);
    setError(null);
    try {
      const data = await parseResponse<{ users: AdminUser[] }>(
        await authFetch("/api/admin/users", { cache: "no-store" })
      );
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load users");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        email,
        displayName: displayName || undefined,
        role,
        byokEnabled
      };
      if (mode === "direct") {
        body.password = password;
        body.forceReset = forceReset;
      }

      const data = await parseResponse<{ userId?: string; inviteUrl?: string; emailDelivery?: EmailDelivery }>(
        await authFetch("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        })
      );

      if (data.inviteUrl) {
        setLinks((current) => [{ label: "Invite", email, url: data.inviteUrl!, delivery: data.emailDelivery }, ...current]);
        setMessage(data.emailDelivery?.status === "sent" ? "Invite email sent. URL is also available below." : "Invite URL generated for manual delivery.");
      } else {
        setMessage("User created.");
      }

      setEmail("");
      setDisplayName("");
      setPassword("");
      setByokEnabled(false);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create user");
    } finally {
      setSaving(false);
    }
  }

  async function updateByok(user: AdminUser, nextValue: boolean) {
    setError(null);
    setUsers((current) => current.map((item) => (item.id === user.id ? { ...item, byok_enabled: nextValue } : item)));
    try {
      await parseResponse<{ userId: string; byokEnabled: boolean }>(
        await authFetch(`/api/admin/users/${encodeURIComponent(user.id)}/byok`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ byokEnabled: nextValue })
        })
      );
      setMessage(`Personal key ${nextValue ? "enabled" : "disabled"} for ${user.email}.`);
    } catch (err) {
      setUsers((current) => current.map((item) => (item.id === user.id ? user : item)));
      setError(err instanceof Error ? err.message : "Unable to update personal key");
    }
  }

  async function createPasswordReset(user: AdminUser) {
    setError(null);
    setMessage(null);
    try {
      const data = await parseResponse<{ resetUrl: string; emailDelivery?: EmailDelivery; email: string }>(
        await authFetch(`/api/admin/users/${encodeURIComponent(user.id)}/password-reset`, { method: "POST" })
      );
      setLinks((current) => [{ label: "Password reset", email: data.email, url: data.resetUrl, delivery: data.emailDelivery }, ...current]);
      setMessage(data.emailDelivery?.status === "sent" ? `Password reset email sent to ${data.email}.` : `Password reset URL generated for ${data.email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create password reset");
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("URL copied to clipboard.");
    } catch {
      setError("Clipboard copy failed. Select and copy the URL manually.");
    }
  }

  return (
    <div className="admin-users">
      <section className="card admin-users__panel">
        <div className="eyebrow">Admin</div>
        <h1>Users</h1>
        <p className="muted">Create users, send invites, and reset passwords.</p>
      </section>

      <section className="admin-console-stats" aria-label="User administration summary">
        <div className="card card--compact admin-console-stat"><span className="eyebrow">Users</span><strong>{stats.total}</strong><span className="muted">total accounts</span></div>
        <div className="card card--compact admin-console-stat"><span className="eyebrow">Admins</span><strong>{stats.admins}</strong><span className="muted">admin role</span></div>
        <div className="card card--compact admin-console-stat"><span className="eyebrow">Personal key</span><strong>{stats.byok}</strong><span className="muted">with personal key</span></div>
        <div className="card card--compact admin-console-stat"><span className="eyebrow">Emergency admin</span><strong>{stats.breakGlass}</strong><span className="muted">protected accounts</span></div>
      </section>

      <section className="card admin-users__panel">
        <div className="admin-users__section-heading">
          <div>
            <div className="eyebrow">Create</div>
            <h2>Add a user</h2>
          </div>
          <div className="admin-users__toggle" aria-label="Creation mode">
            <button className={mode === "invite" ? "button" : "button button--ghost"} type="button" onClick={() => setMode("invite")}>Invite</button>
            <button className={mode === "direct" ? "button" : "button button--ghost"} type="button" onClick={() => setMode("direct")}>Direct</button>
          </div>
        </div>

        <form className="admin-users__form" onSubmit={createUser}>
          <label>Email<input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>Display name<input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Defaults to email" /></label>
          <label>Role<select value={role} onChange={(event) => setRole(event.target.value as "user" | "admin")}><option value="user">User</option><option value="admin">Admin</option></select></label>
          {mode === "direct" ? (
            <>
              <label>Password<input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
              <label className="admin-users__checkbox"><input type="checkbox" checked={forceReset} onChange={(event) => setForceReset(event.target.checked)} />Require password change on first sign-in</label>
            </>
          ) : null}
          <label className="admin-users__checkbox"><input type="checkbox" checked={byokEnabled} onChange={(event) => setByokEnabled(event.target.checked)} />Allow this user to use their own API key</label>
          <button className="button" type="submit" disabled={saving}>{saving ? "Saving..." : mode === "invite" ? "Generate invite" : "Create user"}</button>
        </form>
      </section>

      {error ? <div className="error-state" role="alert">{error}</div> : null}
      {message ? <div className="success-state" role="status">{message}</div> : null}

      {links.length > 0 ? (
        <section className="card admin-users__panel">
          <div className="eyebrow">Links</div>
          <h2>Generated URLs</h2>
          <div className="admin-users__links">
            {links.map((link) => (
              <div className="admin-users__link" key={`${link.label}-${link.url}`}>
                <div><strong>{link.label}</strong><p className="muted">{link.email}{link.delivery ? ` - Delivery: ${formatDelivery(link.delivery)}` : ""}</p><code>{link.url}</code></div>
                <button className="button button--ghost" type="button" onClick={() => void copyUrl(link.url)}>Copy</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="card admin-users__panel">
        <div className="admin-users__section-heading">
          <div><div className="eyebrow">Directory</div><h2>Users</h2></div>
          <button className="button button--ghost" type="button" onClick={() => void loadUsers()} disabled={loading} aria-label="Refresh users">{loading ? "Loading..." : "Refresh"}</button>
        </div>

        <div className="admin-filter-bar">
          <label>
            Search
            <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Email, name, status" />
          </label>
          <label>
            Role
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
              <option value="all">All roles</option>
              <option value="admin">Admins</option>
              <option value="user">Users</option>
            </select>
          </label>
          <label>
            Personal key
            <select value={byokFilter} onChange={(event) => setByokFilter(event.target.value)}>
              <option value="all">All</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>
        </div>

        {loading ? <LoadingBlock title="Loading users" /> : null}

        <div className="admin-users__table-wrap" tabIndex={0} aria-label="Scrollable users table">
          <table className="admin-users__table">
            <caption className="sr-only">Users directory</caption>
            <thead><tr><th scope="col">User</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Personal key</th><th scope="col">Created</th><th scope="col">Last login</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {filteredUsers.map((user) => (
                <tr key={user.id}>
                  <th scope="row"><strong>{user.display_name || user.email}</strong><div className="muted">{user.email}</div></th>
                  <td><StatusBadge tone={user.role === "admin" ? "info" : "neutral"}>{user.role}</StatusBadge></td>
                  <td><div className="admin-badge-row"><StatusBadge>{user.status}</StatusBadge>{user.is_break_glass ? <StatusBadge tone="warning">emergency</StatusBadge> : null}</div></td>
                  <td><label className="admin-users__checkbox admin-users__checkbox--compact"><input type="checkbox" checked={user.byok_enabled} disabled={user.is_break_glass} onChange={(event) => void updateByok(user, event.target.checked)} />{user.byok_enabled ? "Enabled" : "Disabled"}</label></td>
                  <td>{formatDate(user.created_at)}</td>
                  <td>{formatDate(user.last_login_at)}</td>
                  <td><button className="button button--ghost" type="button" disabled={user.is_break_glass} onClick={() => void createPasswordReset(user)}>Reset password</button></td>
                </tr>
              ))}
              {!loading && filteredUsers.length === 0 ? <tr><td colSpan={7}><span className="empty-state">No users match the current filters.</span></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
