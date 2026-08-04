import QuickGenerate from "../components/QuickGenerate";
import RecentCreations from "../components/RecentCreations";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col py-8">
      <div className="mx-auto w-full max-w-[1040px] animate-fade-in">
        <h1 className="mb-1.5 text-center text-[26px] font-semibold tracking-[-0.02em] text-ink">
          Have something <span className="text-ai">quick</span> in mind?
        </h1>
        <p className="mb-8 text-center text-sm text-ink-muted">
          Describe a track and let RITHM compose it.
        </p>

        <QuickGenerate />
        <RecentCreations />
      </div>
    </div>
  );
}
