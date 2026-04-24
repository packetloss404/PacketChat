export type AuthUser = {
  id: string;
  email: string;
  displayName?: string | null;
  role?: string;
  status?: string;
};

export type AuthResponse = {
  accessToken: string;
  user?: AuthUser;
  warning?: string;
};

type MeResponse = {
  user: AuthUser;
};

export const accessTokenKey = "packetchat.accessToken";
const legacyAccessTokenKey = "packetchat_access_token";
const csrfCookieName = "packetchat_csrf";
let memoryAccessToken: string | null = null;

type AuthClientEvent = { type: "token"; accessToken: string | null } | { type: "expired" };
const listeners = new Set<(event: AuthClientEvent) => void>();

export function subscribeAuthClient(listener: (event: AuthClientEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitAuthClient(event: AuthClientEvent) {
  listeners.forEach((listener) => listener(event));
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data ? data.error?.message : null;
    throw new Error(message || `Request failed with ${response.status}`);
  }
  return data as T;
}

export function getAccessToken() {
  if (memoryAccessToken) return memoryAccessToken;
  if (typeof window === "undefined") return null;
  memoryAccessToken = window.localStorage.getItem(accessTokenKey) ?? window.localStorage.getItem(legacyAccessTokenKey);
  return memoryAccessToken;
}

export function storeAccessToken(accessToken: string) {
  memoryAccessToken = accessToken;
  console.warn("PacketChat stores access tokens in localStorage for V1 compatibility; avoid third-party scripts and migrate to an HTTP-only access-token strategy before production hardening is complete.");
  if (typeof window !== "undefined") {
    window.localStorage.setItem(accessTokenKey, accessToken);
    window.localStorage.setItem(legacyAccessTokenKey, accessToken);
  }
  emitAuthClient({ type: "token", accessToken });
}

export function clearAccessToken() {
  const hadToken = Boolean(memoryAccessToken) || (typeof window !== "undefined" && Boolean(window.localStorage.getItem(accessTokenKey) ?? window.localStorage.getItem(legacyAccessTokenKey)));
  memoryAccessToken = null;
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(accessTokenKey);
    window.localStorage.removeItem(legacyAccessTokenKey);
  }
  if (hadToken) emitAuthClient({ type: "token", accessToken: null });
}

export async function logout() {
  const accessToken = getAccessToken();
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: authHeaders(accessToken),
      credentials: "include"
    });
  } finally {
    clearAccessToken();
  }
}

export async function login(email: string, password: string) {
  const result = await postAuth<AuthResponse>("/api/auth/login", { email, password });
  storeAccessToken(result.accessToken);
  return result;
}

export async function breakGlassLogin(email: string, password: string) {
  const result = await postAuth<AuthResponse>("/api/auth/break-glass/login", { email, password });
  storeAccessToken(result.accessToken);
  return result;
}

export async function refreshAccessToken() {
  const result = await postAuth<{ accessToken: string }>("/api/auth/refresh", {});
  storeAccessToken(result.accessToken);
  return result.accessToken;
}

export async function getMe() {
  const response = await authFetch("/api/auth/me");
  return readJson<MeResponse>(response);
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const response = await fetchWithAccessToken(input, init);
  if (response.status !== 401) return response;

  try {
    await refreshAccessToken();
  } catch {
    clearAccessToken();
    emitAuthClient({ type: "expired" });
    return response;
  }

  const retry = await fetchWithAccessToken(input, init);
  if (retry.status === 401) {
    clearAccessToken();
    emitAuthClient({ type: "expired" });
  }
  return retry;
}

export async function acceptInvite(token: string, displayName: string, password: string) {
  return postAuth<{ userId: string }>("/api/auth/invite/accept", { token, displayName, password });
}

export async function completePasswordReset(token: string, password: string) {
  return postAuth<{ ok: true }>("/api/auth/password-reset/complete", { token, password });
}

async function postAuth<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(null, { "Content-Type": "application/json" }),
    credentials: "include",
    body: JSON.stringify(body)
  });
  return readJson<T>(response);
}

function authHeaders(accessToken: string | null, base?: Record<string, string>) {
  const headers: Record<string, string> = { ...(base ?? {}) };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const csrfToken = readCsrfToken();
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return headers;
}

function readCsrfToken() {
  if (typeof document === "undefined") return null;
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${csrfCookieName}=`))?.slice(csrfCookieName.length + 1);
  return value ? decodeURIComponent(value) : null;
}

function fetchWithAccessToken(input: RequestInfo | URL, init: RequestInit) {
  const headers = new Headers(init.headers);
  const accessToken = getAccessToken();
  if (accessToken && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${accessToken}`);

  return fetch(input, {
    ...init,
    headers,
    credentials: init.credentials ?? "include"
  });
}
