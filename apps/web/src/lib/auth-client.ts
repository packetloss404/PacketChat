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
  const data = (await response.json().catch(() => null)) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data ? data.error?.message : null;
    throw new Error(message || `Request failed with ${response.status}`);
  }
  return data as T;
}

export function getAccessToken() {
  return memoryAccessToken;
}

export function storeAccessToken(accessToken: string) {
  memoryAccessToken = accessToken;
  emitAuthClient({ type: "token", accessToken });
}

export function clearAccessToken() {
  const hadToken = Boolean(memoryAccessToken);
  memoryAccessToken = null;
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

let refreshInFlight: Promise<string> | null = null;

export async function refreshAccessToken() {
  if (memoryAccessToken) return memoryAccessToken;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const result = await postAuth<{ accessToken: string }>("/api/auth/refresh", {});
      storeAccessToken(result.accessToken);
      return result.accessToken;
    } catch (error) {
      clearAccessToken();
      throw error;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function getMe() {
  const response = await authFetch("/api/auth/me");
  return readJson<MeResponse>(response);
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  let response = await fetchWithAccessToken(input, init);
  if (response.status !== 401) return response;

  try {
    await refreshAccessToken();
  } catch {
    clearAccessToken();
    emitAuthClient({ type: "expired" });
    return response;
  }

  response = await fetchWithAccessToken(input, init);
  if (response.status === 401) {
    clearAccessToken();
    emitAuthClient({ type: "expired" });
  }
  return response;
}

export async function acceptInvite(token: string, displayName: string, password: string) {
  return postAuth<{ userId: string }>("/api/auth/invite/accept", { token, displayName, password });
}

export async function completePasswordReset(token: string, password: string) {
  return postAuth<{ ok: true }>("/api/auth/password-reset/complete", { token, password });
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const accessToken = getAccessToken();
  const response = await fetch("/api/auth/change-password", {
    method: "POST",
    headers: authHeaders(accessToken, { "Content-Type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({ currentPassword, newPassword })
  });
  return readJson<{ ok: true }>(response);
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
  const value = document.cookie.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${csrfCookieName}=`))
    ?.slice(csrfCookieName.length + 1);
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

