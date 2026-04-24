"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  type AuthResponse,
  type AuthUser,
  breakGlassLogin as clientBreakGlassLogin,
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
  breakGlassLogin: (email: string, password: string) => Promise<AuthResponse>;
  logout: () => Promise<void>;
  refresh: () => Promise<AuthUser | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
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
    async breakGlassLogin(email, password) {
      const result = await clientBreakGlassLogin(email, password);
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

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
