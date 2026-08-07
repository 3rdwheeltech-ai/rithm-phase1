import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Play, Download, Shuffle, Sparkles, Trash2, ArrowLeft } from "lucide-react";
import { useTrack } from "../hooks/useTrack";
import { useGenerate } from "../hooks/useGenerate";
import { useDeleteTrack } from "../hooks/useDeleteTrack";
import { usePlayer } from "../store/player";
import { formatDuration, trackTitle } from "../lib/track";
import JobProgress from "../components/JobProgress";
import ErrorToast from "../components/ErrorToast";
import Segmented from "../components/create/Segmented";
import { coverGradient } from "../components/RecentCreations";
import { DELTA_COMMAND_MAX_LENGTH, type RefinementMode } from "../types/api";

const KIND_LABELS: Record<string, string> = {
  initial: "Created",
  refine_fresh: "Refined",
  refine_audio: "Refined from audio",
  remix: "Remixed",
  variation: "Variation",
};

export default function TrackDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { data: track, isLoading, error: loadError } = useTrack(id);
  const deleteTrack = useDeleteTrack();
  const play = usePlayer((s) => s.play);

  const [delta, setDelta] = useState("");
  const [mode, setMode] = useState<RefinementMode>("fresh");
  const [dismissed, setDismissed] = useState(false);

  const { variation, refine, stream, busy, error } = useGenerate({
    onCompleted: (trackId) => {
      if (trackId) nav(`/track/${trackId}`);
    },
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-8">
        <span className="h-6 w-6 rounded-full border-2 border-white/15 border-t-signal-bright motion-safe:animate-spin" />
      </div>
    );
  }

  if (!track) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
        <p className="text-md font-medium text-ink">That track is no longer available.</p>
        <button type="button" onClick={() => nav("/library")} className="btn-primary mt-5 w-auto px-5">
          Back to library
        </button>
        <ErrorToast error={loadError} onDismiss={() => undefined} />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col py-6 sm:py-8">
      <JobProgress stream={stream} />
      {!dismissed && <ErrorToast error={error} onDismiss={() => setDismissed(true)} />}

      <div className="mx-auto w-full max-w-[860px] animate-fade-in">
        <button
          type="button"
          onClick={() => nav("/library")}
          className="mb-5 flex min-h-[40px] items-center gap-1.5 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Library
        </button>

        <div className="surface flex flex-col gap-5 p-4 sm:flex-row sm:p-6">
          <div
            // Capped and centred on a phone: a full-bleed square pushes the
            // title and the controls below the fold on a 390px screen.
            className={`mx-auto aspect-square w-full max-w-[220px] flex-shrink-0 rounded-card bg-gradient-to-br sm:mx-0 sm:h-[160px] sm:w-[160px] sm:max-w-none ${coverGradient(track.id)}`}
          />

          <div className="min-w-0 flex-1">
            <h1 className="font-display text-xl font-semibold text-ink">
              {trackTitle(track)}
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{track.prompt}</p>

            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-ink-faint">
              <span>{formatDuration(track.length_seconds)}</span>
              {track.genre && <span>{track.genre}</span>}
              {track.mood && <span>{track.mood}</span>}
              {track.bpm !== null && <span>{track.bpm} BPM</span>}
              <span>{track.vocal ? "Vocal" : "Instrumental"}</span>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2.5 sm:flex sm:flex-wrap sm:items-center">
              <button
                type="button"
                onClick={() => play(track)}
                className="glass-btn glass-btn-solid col-span-2 flex min-h-[44px] items-center justify-center gap-2 rounded-el px-4 text-sm font-semibold sm:col-span-1"
              >
                <Play className="h-4 w-4" strokeWidth={2} fill="currentColor" />
                Play
              </button>

              <button
                type="button"
                onClick={() => {
                  setDismissed(false);
                  variation.mutate(track.id);
                }}
                disabled={busy}
                className="glass-btn flex min-h-[44px] items-center justify-center gap-2 rounded-el px-4 text-sm font-medium disabled:opacity-40"
              >
                <Shuffle className="h-4 w-4" strokeWidth={2} />
                Variation
              </button>

              {/* Both presigned, both 15-minute TTL. */}
              <a
                href={track.mp3_url}
                download
                className="glass-btn flex min-h-[44px] items-center justify-center gap-2 rounded-el px-4 text-sm font-medium"
              >
                <Download className="h-4 w-4" strokeWidth={2} />
                MP3
              </a>
              <a
                href={track.wav_url}
                download
                className="glass-btn flex min-h-[44px] items-center justify-center gap-2 rounded-el px-4 text-sm font-medium"
              >
                <Download className="h-4 w-4" strokeWidth={2} />
                WAV
              </a>

              <button
                type="button"
                onClick={() => {
                  deleteTrack.mutate(track.id);
                  nav("/library");
                }}
                title="Delete"
                aria-label="Delete track"
                className="col-span-2 flex min-h-[44px] items-center justify-center gap-2 rounded-control text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger sm:col-span-1 sm:ml-auto sm:h-9 sm:w-9 sm:min-h-0"
              >
                <Trash2 className="h-4 w-4" strokeWidth={2} />
                {/* A bare icon alone in a row reads as an orphan on mobile,
                    where there is no hover to explain it. */}
                <span className="text-sm font-medium sm:hidden">Delete</span>
              </button>
            </div>
          </div>
        </div>

        {/* Refine */}
        <div className="surface mt-4 p-4 sm:p-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-md font-semibold text-ink">
              <Sparkles className="h-4 w-4 text-signal-bright" strokeWidth={2} />
              Refine
            </h2>
            <Segmented<RefinementMode>
              ariaLabel="Refinement mode"
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "fresh", label: "Fresh" },
                {
                  // Rejected at the API edge AND in the worker, deliberately.
                  // Rendered disabled: hiding it means the same question gets
                  // asked every week, enabling it means a 400 nobody can act on.
                  value: "audio_reference",
                  label: "From audio",
                  disabled: true,
                  title: "Audio-reference refinement is coming later",
                },
              ]}
            />
          </div>

          <textarea
            value={delta}
            maxLength={DELTA_COMMAND_MAX_LENGTH}
            onChange={(e) => setDelta(e.target.value)}
            aria-label="What should change"
            placeholder="What should change? e.g. make it slower and add strings"
            className="glass-input min-h-[84px] resize-none leading-relaxed"
          />

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="font-mono text-2xs tabular-nums text-ink-faint">
              {delta.length} / {DELTA_COMMAND_MAX_LENGTH}
            </span>
            <button
              type="button"
              disabled={busy || delta.trim().length === 0}
              onClick={() => {
                setDismissed(false);
                refine.mutate({
                  trackId: track.id,
                  body: { delta_command: delta.trim(), refinement_mode: "fresh" },
                });
              }}
              className="glass-btn glass-btn-solid min-h-[44px] rounded-el px-5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Refining…" : "Refine"}
            </button>
          </div>
        </div>

        {/* Prompt history — already embedded in the detail response, so this
            costs no extra request. */}
        {track.prompt_history.length > 0 && (
          <div className="surface mt-4 p-4 sm:p-6">
            <h2 className="mb-4 text-md font-semibold text-ink">History</h2>
            <ol className="space-y-3">
              {track.prompt_history.map((entry) => (
                <li key={entry.id} className="border-l border-white/10 pl-4">
                  <div className="flex items-baseline gap-2">
                    <span className="eyebrow">
                      {KIND_LABELS[entry.kind] ?? entry.kind}
                    </span>
                    <span className="font-mono text-2xs text-ink-faint">
                      {new Date(entry.created_at).toLocaleString()}
                    </span>
                  </div>
                  {entry.delta_command && (
                    <p className="mt-1 text-sm text-ink">“{entry.delta_command}”</p>
                  )}
                  <p className="mt-1 text-xs leading-snug text-ink-faint">{entry.prompt}</p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
