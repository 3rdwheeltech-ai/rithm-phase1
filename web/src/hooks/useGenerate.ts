import { useMutation } from "@tanstack/react-query";
import { request } from "../lib/api";
import type { GenerateRequest, JobAccepted, RefineRequest } from "../types/api";
import { selectBusy, useGeneration } from "../store/generation";

export interface UseGenerateOptions {
  /**
   * Whether THIS submission leaves the words to the model — vocals asked for
   * and no lyrics supplied. A getter, not a value: it depends on form state at
   * the moment of submit, and the pill needs the answer to decide between
   * "Generating lyrics…" and "Composing the song…".
   */
  writesLyrics?: () => boolean;
}

/**
 * One submit path for all three write routes.
 *
 * QuickGenerate and the full Create form differ only in how much of
 * GenerateRequest they let the user fill in; both land here, so there is one
 * place where a 202 turns into a live stream.
 *
 * This hook no longer OWNS that stream. It hands the accepted job to the
 * generation store and `GenerationPill` — which is mounted for the life of the
 * app — opens the EventSource. Keeping it here meant the stream died with
 * whichever form started it, which is fine behind a modal that pins the user in
 * place and fatal behind a status pill that doesn't.
 */
export function useGenerate({ writesLyrics }: UseGenerateOptions = {}) {
  const begin = useGeneration((s) => s.begin);
  const accept = useGeneration((s) => s.accept);
  const abandon = useGeneration((s) => s.abandon);
  const stream = useGeneration((s) => s.stream);
  const busy = useGeneration(selectBusy);

  const shared = {
    onMutate: () => {
      begin(writesLyrics?.() ?? false);
    },
    onSuccess: (accepted: JobAccepted) => {
      // Use sse_url VERBATIM. It is relative and already carries the signed
      // token; reconstructing it drops the token.
      accept({ jobId: accepted.job_id, sseUrl: accepted.sse_url });
    },
    // Nothing was ever queued, so there is no job to show a status for — clear
    // the pill and let the form's ErrorToast say what went wrong.
    onError: () => {
      abandon();
    },
  };

  const generate = useMutation({
    mutationFn: (body: GenerateRequest) =>
      request<JobAccepted>("/tracks/generate", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    ...shared,
  });

  const variation = useMutation({
    mutationFn: (trackId: string) =>
      request<JobAccepted>(`/tracks/${trackId}/variation`, { method: "POST" }),
    ...shared,
  });

  const refine = useMutation({
    mutationFn: ({ trackId, body }: { trackId: string; body: RefineRequest }) =>
      request<JobAccepted>(`/tracks/${trackId}/refine`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    ...shared,
  });

  return {
    generate,
    variation,
    refine,
    stream,
    /**
     * True while anything is in flight. One generation at a time is a UX
     * decision AND what keeps the 20/day budget legible. It now comes from the
     * store, so it survives navigation the same way the pill does.
     */
    busy,
    reset: () => {
      useGeneration.getState().reset();
      generate.reset();
      variation.reset();
      refine.reset();
    },
    error: generate.error ?? variation.error ?? refine.error ?? null,
  };
}
