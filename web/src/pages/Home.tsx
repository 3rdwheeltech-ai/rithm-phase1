import QuickGenerate from "../components/QuickGenerate";
import RecentCreations from "../components/RecentCreations";
import VoiceCard from "../components/assistant/VoiceCard";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col py-8 sm:py-12">
      <div className="mx-auto w-full max-w-[1040px] animate-fade-in">
        <h1 className="mb-1.5 text-balance text-center font-display text-xl font-semibold text-ink sm:text-2xl">
          Have something <span className="text-ai">quick</span> in mind?
        </h1>
        <p className="mb-7 text-center text-sm text-ink-muted sm:mb-9">
          Describe a track and let RITHM compose it.
        </p>

        <QuickGenerate />
        {/*
          The assistant's only entry point below `lg`, where the right-hand
          rail — and with it AvatarPanel — does not exist. `lg:hidden` rather
          than a breakpoint check in JS, so it costs nothing on desktop and
          cannot disagree with `Layout`'s own variant.
        */}
        <VoiceCard className="lg:hidden" />
        <RecentCreations />
      </div>
    </div>
  );
}
