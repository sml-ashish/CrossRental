import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, clearStoredToken, getStoredToken, storeToken } from "./api";
import { AuthContext, type AuthResponse, type AuthUser } from "./auth";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  // A stored token is not proof of a session: it has to survive one round trip
  // to /auth/me, which is also what catches a deactivated account.
  const [isLoading, setIsLoading] = useState<boolean>(() => getStoredToken() !== null);
  const queryClient = useQueryClient();

  const endSession = useCallback(() => {
    clearStoredToken();
    setToken(null);
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    if (!token) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const me = await api<{ user: AuthUser }>("/auth/me");
        if (cancelled) return;
        setUser(me.user);
      } catch (error) {
        if (cancelled) return;
        // An expired or revoked token is cleared; so is any failure to reach
        // /auth/me, because the alternative is showing a portal shell that
        // silently fails on every request behind it.
        if (error instanceof ApiError && error.status === 0) {
          setUser(null);
        } else {
          clearStoredToken();
          setToken(null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const setSession = useCallback(
    (auth: AuthResponse) => {
      storeToken(auth.token);
      setToken(auth.token);
      setUser(auth.user);
      setIsLoading(false);
    },
    [],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const auth = await api<AuthResponse>("/auth/login", {
        method: "POST",
        body: { email, password },
        anonymous: true,
      });
      setSession(auth);
      return auth.user;
    },
    [setSession],
  );

  const loginWithOtp = useCallback(
    async (email: string, code: string) => {
      const auth = await api<AuthResponse>("/auth/otp/verify", {
        method: "POST",
        body: { email, code },
        anonymous: true,
      });
      setSession(auth);
      return auth.user;
    },
    [setSession],
  );

  const logout = useCallback(() => {
    endSession();
  }, [endSession]);

  const value = useMemo(
    () => ({
      user,
      token,
      isAuthenticated: user !== null,
      isLoading,
      login,
      loginWithOtp,
      logout,
      setSession,
    }),
    [user, token, isLoading, login, loginWithOtp, logout, setSession],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}