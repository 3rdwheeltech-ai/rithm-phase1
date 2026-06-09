import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface AuthState {
  idToken: string | null;
  refreshToken: string | null;
  email: string | null;
  setAuth: (auth: { idToken: string; refreshToken: string; email: string }) => void;
  clear: () => void;
}

/**
 * Auth session store. Persisted to localStorage so a page reload keeps the
 * user signed in until the tokens are explicitly cleared (sign out / 401).
 */
export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      idToken: null,
      refreshToken: null,
      email: null,
      setAuth: ({ idToken, refreshToken, email }) => set({ idToken, refreshToken, email }),
      clear: () => set({ idToken: null, refreshToken: null, email: null }),
    }),
    { name: "rithm-auth" },
  ),
);
