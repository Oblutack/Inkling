"use client";

import React, {
  createContext,
  useState,
  useContext,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import axios from "axios";
import { API_URL } from "../lib/api";
import type { User } from "../types";

interface AuthContextType {
  user: User | null;
  // True until we know whether the browser holds a valid session.
  loading: boolean;
  // Call after a successful login with the user the server returned.
  login: (user: User) => void;
  // Ends the session on the server (revoking it) and locally.
  logout: () => Promise<void>;
  // Re-reads the user, e.g. after verifying an email address.
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Requests where a 401 means "wrong credentials", not "your session ended".
const CREDENTIAL_ENDPOINTS = [
  "/login",
  "/signup",
  "/auth/google",
  "/auth/two-factor",
  "/auth/logout",
  "/auth/me",
  "/auth/forgot-password",
  "/auth/reset-password",
  "/auth/verify-email",
];

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // The session is an httpOnly cookie, which scripts cannot see, so asking the server is the only
  // way to know who (if anyone) is signed in. This also validates the session for real.
  const refresh = useCallback(async () => {
    try {
      const response = await axios.get<{ user: User }>(`${API_URL}/auth/me`);
      setUser(response.data.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    // Earlier versions kept a login token in localStorage, where any script on the page could read
    // it. Sessions now live in an httpOnly cookie; remove the stale copy.
    try {
      localStorage.removeItem("token");
    } catch {
      // Storage can be unavailable (private mode); nothing to clean up then.
    }
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  // If the server says our session is gone (expired, revoked from another device, account
  // deleted), drop the signed-in state so protected pages send the user back to login instead of
  // failing with a generic error.
  useEffect(() => {
    const id = axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          // Only the server's explicit "unauthenticated" means the session ended; a 401 from the
          // login form (wrong credentials) must not sign anyone out.
          const path = (error.config?.url ?? "").replace(API_URL, "").split("?")[0];
          const sessionEnded = error.response.data?.code === "unauthenticated";
          if (sessionEnded && !CREDENTIAL_ENDPOINTS.includes(path)) {
            setUser(null);
          }
        }
        return Promise.reject(error);
      }
    );
    return () => axios.interceptors.response.eject(id);
  }, []);

  const login = useCallback((next: User) => setUser(next), []);

  const logout = useCallback(async () => {
    try {
      await axios.post(`${API_URL}/auth/logout`);
    } catch {
      // Even if the request fails, forget the user locally; the cookie is still cleared server-side
      // the next time any request is made.
    }
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
};

// Convenience hook for reading the auth context
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
