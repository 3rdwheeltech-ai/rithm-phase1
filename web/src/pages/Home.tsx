import QuickGenerate from "../components/QuickGenerate";
import Recents from "../components/Recents";
import ModeToggle from "../components/ModeToggle";

export default function Home() {
  return (
    <>
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
    </>
  );
}
