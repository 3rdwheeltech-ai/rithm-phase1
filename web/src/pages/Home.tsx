import { useNavigate } from "react-router-dom";
import { decodeJwt } from "../lib/jwt";
import { useAuth } from "../store/auth";
import Sidebar from "../components/Sidebar";
import QuickGenerate from "../components/QuickGenerate";
import Recents from "../components/Recents";
import Player from "../components/Player";
import ModeToggle from "../components/ModeToggle";

export default function Home() {
  const nav = useNavigate();
  const clear = useAuth((s) => s.logout);
  const idToken = useAuth((s) => s.idToken);
  const user = useAuth((s) => s.user);
  // Everything the UI needs about the user is already in the id token, so there
  // is no GET /me round trip for it.
  const name = (decodeJwt(idToken)?.name ?? "").trim() || null;

  function logout() {
    clear();
    nav("/login", { replace: true });
  }

  return (
    <div className="app-bg fixed inset-0">
      <Sidebar name={name} email={user?.email ?? null} onSignOut={logout} />
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
          </div>
        </div>
      </main>
    </div>
  );
}
