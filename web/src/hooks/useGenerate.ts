import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { request } from "../lib/api";
import type { GenerateRequest, JobAccepted, RefineRequest } from "../types/api";
import { useJobStream, type JobHandle, type JobStreamOptions } from "./useJobStream";

/**
 * One submit path for all three write routes.
 *
 * QuickGenerate and the full Create form differ only in how much of
 * GenerateRequest they let the user fill in; both land here, so there is one
 * place where a 202 turns into a live stream.
 */
export function useGenerate(options: JobStreamOptions = {}) {
  const [job, setJob] = useState<JobHandle | null>(null);
  const stream = useJobStream(job, options);

  const accept = (accepted: JobAccepted) => {
    // Use sse_url VERBATIM. It is relative and already carries the signed
    // token; reconstructing it drops the token.
    setJob({ jobId: accepted.job_id, sseUrl: accepted.sse_url });
  };

  const generate = useMutation({
    mutationFn: (body: GenerateRequest) =>
      request<JobAccepted>("/tracks/generate", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: accept,
  });

  const variation = useMutation({
    mutationFn: (trackId: string) =>
      request<JobAccepted>(`/tracks/${trackId}/variation`, { method: "POST" }),
    onSuccess: accept,
  });

  const refine = useMutation({
    mutationFn: ({ trackId, body }: { trackId: string; body: RefineRequest }) =>
      request<JobAccepted>(`/tracks/${trackId}/refine`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: accept,
  });

  const busy =
    generate.isPending ||
    variation.isPending ||
    refine.isPending ||
    stream.phase === "queued" ||
    stream.phase === "running";

  return {
    generate,
    variation,
    refine,
    stream,
    /**
     * True while anything is in flight. One generation at a time per user is a
     * UX decision AND what keeps the 20/day budget legible.
     */
    busy,
    reset: () => {
      setJob(null);
      generate.reset();
      variation.reset();
      refine.reset();
    },
    error: generate.error ?? variation.error ?? refine.error ?? null,
  };
}
