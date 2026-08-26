"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  type AuthResponse,
  type AuthUser,
  clearAccessToken,
  getAccessToken,
  getMe,
  login as clientLogin,
  logout as clientLogout,
  refreshAccessToken,
  subscribeAuthClient
} from "../lib/auth-client";

type AuthStatus = "loading" | "authenticated" | "anonymous";

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  accessToken: string | null;
  login: (email: string, password: string) => Promise<AuthResponse>;
  logout: () => Promise<void>;
  refresh: () => Promise<AuthUser | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const PUBLIC_PATHS = new Set<string>(["/login"]);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() => getAccessToken());

  async function loadCurrentUser() {
    if (!getAccessToken()) {
      try {
        await refreshAccessToken();
      } catch {
        setUser(null);
        setAccessToken(null);
        setStatus("anonymous");
        return null;
      }
    }

    try {
      const me = await getMe();
      const nextToken = getAccessToken();
      setUser(me.user);
      setAccessToken(nextToken);
      setStatus("authenticated");
      return me.user;
    } catch {
      clearAccessToken();
      setUser(null);
      setAccessToken(null);
      setStatus("anonymous");
      return null;
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      const currentUser = await loadCurrentUser();
      if (cancelled) return;
      setStatus(currentUser ? "authenticated" : "anonymous");
    }

    const unsubscribe = subscribeAuthClient((event) => {
      if (cancelled) return;
      if (event.type === "token") {
        setAccessToken(event.accessToken);
        if (!event.accessToken) {
          setUser(null);
          setStatus("anonymous");
        }
      }
      if (event.type === "expired") {
        setUser(null);
        setAccessToken(null);
        setStatus("anonymous");
      }
    });

    void initialize();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Client-side route guard: when the auth provider resolves to anonymous
  // on a protected page, bounce to /login with the current path as `next`.
  useEffect(() => {
    if (status !== "anonymous") return;
    if (typeof window === "undefined") return;
    const safePath = pathname && pathname.startsWith("/") && !pathname.startsWith("//") ? pathname + window.location.search : "/";
    if (PUBLIC_PATHS.has(pathname)) return;
    const target = `/login?next=${encodeURIComponent(safePath)}`;
    if (window.location.pathname + window.location.search === safePath) {
      // Avoid loops if middleware already redirected us.
      if (window.location.pathname === "/login") return;
    }
    router.replace(target);
  }, [status, pathname, router]);

  const value = useMemo<AuthContextValue>(() => ({
    status,
    user,
    accessToken,
    async login(email, password) {
      const result = await clientLogin(email, password);
      setAccessToken(result.accessToken);
      setUser(result.user ?? null);
      setStatus(result.user ? "authenticated" : "loading");
      if (!result.user) await loadCurrentUser();
      return result;
    },
    async logout() {
      await clientLogout();
      setUser(null);
      setAccessToken(null);
      setStatus("anonymous");
    },
    async refresh() {
      try {
        await refreshAccessToken();
        return await loadCurrentUser();
      } catch (error) {
        clearAccessToken();
        setUser(null);
        setAccessToken(null);
        setStatus("anonymous");
        throw error;
      }
    }
  }), [accessToken, status, user]);

  // Never paint protected content for a visitor who is not (yet) known to be
  // authenticated. The middleware only checks that a refresh cookie exists; a
  // stale cookie lets the request through, and without this gate the page
  // would flash before the client-side guard above redirects to /login.
  const isPublic = PUBLIC_PATHS.has(pathname);
  const canRender = isPublic || status === "authenticated";

  return <AuthContext.Provider value={value}>{canRender ? children : null}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
