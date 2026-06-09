import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../store/auth";
import Sidebar from "../components/Sidebar";
import QuickGenerate from "../components/QuickGenerate";
import Recents from "../components/Recents";
import Player from "../components/Player";
import ModeToggle from "../components/ModeToggle";

interface Me {
  user_id: string;
  email: string;
  is_admin: boolean;
}

export default function Home() {
  const nav = useNavigate();
  const clear = useAuth((s) => s.clear);

  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // On a 401 apiFetch clears the session, which makes ProtectedRoute redirect.
    apiFetch<Me>("/api/v1/me")
      .then(setMe)
      .catch((e) => setErr((e as Error).message));
  }, []);

  function logout() {
    clear();
    nav("/login", { replace: true });
  }

  return (
    <div className="app-bg fixed inset-0">
      <Sidebar email={me?.email ?? null} onSignOut={logout} />
      <Player />

      <main className="ml-[88px] mr-[82px] flex h-full flex-col overflow-y-auto px-6">
        {/* Top bar — Basic/Pro toggle */}
        <div className="flex justify-center pt-6">
          <ModeToggle />
        </div>

        {/* Centered studio column */}
        <div className="flex flex-1 flex-col items-center justify-center py-8">
          <div className="w-full max-w-[720px] animate-fade-in">
            <h1 className="mb-1.5 text-center text-[26px] font-semibold tracking-[-0.02em] text-ink">
              Have something <span className="text-ai">quick</span> in mind?
            </h1>
            <p className="mb-8 text-center text-sm text-ink-muted">
              Describe a track and let RITHM compose it.
            </p>

            <QuickGenerate />
            <Recents />

            {err && (
              <div className="mt-5 rounded-[9px] border border-red-400/20 bg-red-400/[0.07] px-3 py-2.5 text-center text-[13px] text-red-300">
                {err}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
