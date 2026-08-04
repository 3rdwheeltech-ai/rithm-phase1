import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface AuthUser {
  sub: string;
  email: string;
}

export type AuthStatus = "loading" | "authed" | "anon";

export interface AuthState {
  /**
   * In MEMORY only — deliberately never persisted. This is the credential that
   * spends GPU budget, so keeping it out of localStorage means an XSS payload
   * cannot lift a working token by reading storage.
   */
  idToken: string | null;
  /**
   * Persisted, alongside the email. A page reload must not log the user out and
   * there is no BFF to hold an httpOnly cookie, so this is the Phase-1 trade.
   * The email rides along because POST /auth/refresh needs it to resolve the
   * Cognito SECRET_HASH — it is not optional on that call.
   */
  refreshToken: string | null;
  email: string | null;

  user: AuthUser | null;
  status: AuthStatus;

  setSession: (session: {
    idToken: string;
    refreshToken?: string | null;
    email: string;
    user: AuthUser | null;
  }) => void;
  /** Refresh succeeded: swap the id token, keep everything else. */
  setIdToken: (idToken: string, user: AuthUser | null) => void;
  setStatus: (status: AuthStatus) => void;
  logout: () => void;
}

/**
 * Auth session state. Deliberately network-free: every call that talks to the
 * API lives in lib/api.ts, which imports this store. Putting a fetch here would
 * make that a cycle.
 */
export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      idToken: null,
      refreshToken: null,
      email: null,
      user: null,
      status: "loading",

      setSession: ({ idToken, refreshToken, email, user }) =>
        set((s) => ({
          idToken,
          // Cognito does not rotate the refresh token on REFRESH_TOKEN_AUTH, so
          // a null here means "unchanged", not "revoked".
          refreshToken: refreshToken ?? s.refreshToken,
          email,
          user,
          status: "authed",
        })),

      setIdToken: (idToken, user) => set({ idToken, user, status: "authed" }),

      setStatus: (status) => set({ status }),

      logout: () =>
        set({
          idToken: null,
          refreshToken: null,
          email: null,
          user: null,
          status: "anon",
        }),
    }),
    {
      name: "rithm-auth",
      // Only these two survive a reload. idToken is memory-only by design; user
      // and status are derived from it on bootstrap.
      partialize: (s) => ({ refreshToken: s.refreshToken, email: s.email }),
    },
  ),
);
