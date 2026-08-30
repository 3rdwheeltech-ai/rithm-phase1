import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import { OPENING_LINE } from "../lib/chat";
import { VoiceTurnLoop, type VoiceEndReason } from "../lib/anam/VoiceTurnLoop";
import {
  buildVoiceClient,
  endVoiceSession,
  forgetVoiceClient,
  loadAnamSdk,
  mintVoiceSession,
  rememberLease,
  streamToStage,
  voiceSupported,
} from "../lib/anam/session";
import { useAssistant, VOICE_COOLDOWN_MS, type VoiceFailure } from "../store/assistant";
import { usePlayer } from "../store/player";
import type { VoiceCaption } from "../components/assistant/VoiceStage";
import { useChatSession } from "./useChat";
import { useVoiceTurn } from "./useVoiceTurn";
import {
  VOICE_AT_CAPACITY_TYPE,
  VOICE_NOT_CONFIGURED_TYPE,
  VOICE_QUOTA_EXCEEDED_TYPE,
} from "../types/api";

/**
 * One voice session, from the press of Talk to the last thing torn down.
 *
 * A HOOK RATHER THAN CODE IN `AvatarPanel`, because there are two surfaces —
 * the desktop panel and the mobile sheet — and every rule below has to hold on
 * both. Duplicating the lifecycle in two components is how one of them ends up
 * not pausing the player, or not releasing the lease on unmount.
 *
 * The turn loop itself is deliberately NOT in here: it is a plain class taking
 * its client as a constructor argument, so it can be tested with no React and
 * no WebRTC. This hook is the part that has to know about React.
 */

/** How long a hidden tab may stay hidden before the session ends quietly. */
const HIDDEN_GRACE_MS = 20_000;
/** No `VIDEO_PLAY_STARTED` by now and we assume the browser refused to play. */
const AUTOPLAY_GRACE_MS = 4_000;
/** No connection by now and the network is blocking WebRTC. */
const CONNECT_TIMEOUT_MS = 15_000;
/** A quota refusal is not retryable in a minute; cool Talk down properly. */
const QUOTA_COOLDOWN_MS = 15 * 60_000;

export interface VoiceSession {
  captions: VoiceCaption[];
  pendingTranscript: string | null;
  videoRef: React.RefObject<HTMLVideoElement>;
  /** Press Talk. SYNCHRONOUS on purpose — see the body. */
  start: () => void;
  end: () => void;
  /** The "Tap to start" fallback, which is a fresh user gesture. */
  retryGesture: () => void;
  /** False while a cooldown is running, or where the browser cannot do voice. */
  canStart: boolean;
  supported: boolean;
}

let captionSeq = 0;

export function useVoiceSession(): VoiceSession {
  const recordTurns = useVoiceTurn();
  const { data: session } = useChatSession();

  const setMode = useAssistant((s) => s.setMode);
  const setVoiceStatus = useAssistant((s) => s.setVoiceStatus);
  const setVoicePhase = useAssistant((s) => s.setVoicePhase);
  const setVoiceRemainingMs = useAssistant((s) => s.setVoiceRemainingMs);
  const failVoice = useAssistant((s) => s.failVoice);
  const resetVoice = useAssistant((s) => s.resetVoice);
  const status = useAssistant((s) => s.voiceStatus);
  const cooldownUntil = useAssistant((s) => s.voiceCooldownUntil);

  const [captions, setCaptions] = useState<VoiceCaption[]>([]);
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const loopRef = useRef<VoiceTurnLoop | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const hiddenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playedRef = useRef(false);
  /** The transcript as of session start, for the greeting. Read once. */
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const supported = voiceSupported();
  const canStart = supported && Date.now() >= cooldownUntil;

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    if (ticker.current !== null) clearInterval(ticker.current);
    ticker.current = null;
    if (hiddenTimer.current !== null) clearTimeout(hiddenTimer.current);
    hiddenTimer.current = null;
  }, []);

  /**
   * Tear everything down. IDEMPOTENT — it runs on unmount, on the door switch,
   * on a route change, on Escape, at the three-minute cap and on `pagehide`,
   * and several of those fire together.
   */
  const teardown = useCallback(
    (failure: VoiceFailure | null, cooldownMs = VOICE_COOLDOWN_MS) => {
      clearTimers();
      playedRef.current = false;
      loopRef.current?.dispose();
      loopRef.current = null;
      setPendingTranscript(null);
      if (failure !== null) failVoice(failure, cooldownMs);
      else resetVoice();
      void endVoiceSession();
    },
    [clearTimers, failVoice, resetVoice],
  );

  const onEnd = useCallback(
    (reason: VoiceEndReason) => {
      // Read BEFORE teardown disposes the loop that knows the answer.
      const cutOff = loopRef.current?.hasUnspokenReply() ?? false;
      // Every `VoiceEndReason` is also a `VoiceFailure` — the loop's reasons
      // are a subset of the panel's, deliberately, so the copy table below has
      // a line for each without a second mapping in between.
      teardown(reason);

      /*
        TWO REASONS TO HAND THE USER TO CHAT, and both are about not losing
        something they have already paid for.

        A 409 means this conversation is full, and starting a fresh one is a
        control that exists only in the chat panel. A drop that cut a reply
        mid-sentence means a Bedrock turn was spent on an answer they only half
        heard — and it is already sitting in `qk.chat`, ready to read.
      */
      if (reason === "chat-full" || (reason === "dropped" && cutOff)) {
        setMode("chat");
      }
    },
    [teardown, setMode],
  );

  /**
   * Press Talk.
   *
   * The first two statements are SYNCHRONOUS and that is the whole point. iOS
   * user activation is transient and is consumed by an `await`; the token mint
   * and the dynamic import are both awaits, so by the time
   * `streamToVideoElement()` runs the gesture is long gone. Priming the element
   * inside the click handler is what makes iOS grant THIS element permission
   * and remember it. It is layer 2 of three, and it is not sufficient on its
   * own — layer 3 is the "Tap to start" overlay.
   */
  const start = useCallback(() => {
    if (!canStart || status !== "idle") return;

    videoRef.current?.play().catch(() => undefined);

    /*
      Pause the music, and this is not a courtesy.

      `<Player>` can be playing a generated track on Home while the microphone
      is open. Anam's STT would transcribe THE SONG'S OWN LYRICS as user
      speech, the loop would POST them to /chat/messages, and the result is the
      daily cap burned, the draft corrupted with words nobody said, and a
      transcript in Chat full of sentences the user never uttered.

      There is no clever fix: browser AEC references the whole output device
      and cannot subtract an element it does not know about. And on iOS,
      opening the microphone switches the audio session category and can duck
      or stop <audio> anyway — so the choice is between doing this deliberately
      with an explanation, or having iOS do it silently and having the user
      read it as the app breaking their music.
    */
    usePlayer.getState().setPlaying(false);

    setCaptions([]);
    setPendingTranscript(null);
    setVoiceStatus("checking");
    void begin();

    async function begin(): Promise<void> {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        failVoice("offline");
        return;
      }

      let minted;
      try {
        minted = await mintVoiceSession();
      } catch (error) {
        failVoice(...mintFailure(error));
        return;
      }
      rememberLease(minted.lease_id);

      let create;
      try {
        create = await loadAnamSdk();
      } catch {
        // The CHUNK did not arrive: a bad deploy, or a cache holding a name
        // that no longer exists. Never retried automatically.
        forgetVoiceClient();
        failVoice("sdk-load-failed");
        return;
      }

      let client;
      try {
        client = buildVoiceClient(create, minted.session_token);
      } catch {
        // The chunk is fine and the CREDENTIAL is not — the SDK decodes the
        // session token as a JWT. That is a server-side problem wearing a
        // client-side coat, so it must not read as a failed download.
        forgetVoiceClient();
        failVoice("connect-failed");
        return;
      }

      const loop = new VoiceTurnLoop({
        client,
        recordTurns,
        onPhase: setVoicePhase,
        onUserTranscript: (text) => {
          setPendingTranscript(null);
          setCaptions((rows) => [
            ...rows,
            { id: `u${(captionSeq += 1)}`, role: "user", text },
          ]);
        },
        // The second argument is always empty now and the signature keeps it
        // only so the loop's contract does not change shape twice. Chips were
        // generated against the assistant's OWN reply, server-side; Anam writes
        // that reply now, so there is nothing to generate them from without a
        // model call that would hand back the latency this switch bought.
        onAssistantReply: (text) => {
          setCaptions((rows) => [
            ...rows,
            { id: `a${(captionSeq += 1)}`, role: "assistant", text },
          ]);
        },
        onVideoPlaying: () => onVideoPlaying(minted.expires_in_seconds),
        onEnd,
      });
      // BEFORE streamToVideoElement, always: startup events fire during that
      // call and a listener registered afterwards misses what already fired.
      loop.attach();
      loopRef.current = loop;

      setVoiceStatus("connecting");
      timers.current.push(
        setTimeout(() => {
          if (useAssistant.getState().voiceStatus === "connecting") {
            teardown("connect-failed");
          }
        }, CONNECT_TIMEOUT_MS),
      );

      try {
        await streamToStage();
      } catch {
        teardown("connect-failed");
        return;
      }

      // Layer 3: the guaranteed path. If this rejects with NotAllowedError, or
      // the video simply never starts, the user gets a fresh gesture to spend.
      try {
        await videoRef.current?.play();
      } catch {
        setVoiceStatus("needs-gesture");
      }
      timers.current.push(
        setTimeout(() => {
          if (!playedRef.current) setVoiceStatus("needs-gesture");
        }, AUTOPLAY_GRACE_MS),
      );
    }

    /**
     * The video is actually playing. THE SESSION CLOCK STARTS HERE, not at the
     * press: a 20 s connect is a ninth of the whole three-minute budget, and
     * spending it on a black rectangle is spending it on nothing.
     */
    function onVideoPlaying(seconds: number): void {
      if (playedRef.current) return;
      playedRef.current = true;
      setVoiceStatus("live");
      setVoicePhase("listening");

      const endsAt = Date.now() + seconds * 1000;
      setVoiceRemainingMs(seconds * 1000);
      ticker.current = setInterval(() => {
        const left = endsAt - Date.now();
        setVoiceRemainingMs(Math.max(0, left));
        if (left <= 0) teardown("time-limit", 0);
      }, 500);

      greet();
    }

    /**
     * The first thing the avatar says.
     *
     * If the transcript already has turns, it speaks the LAST ASSISTANT one —
     * so a user arriving from Chat is picked up mid-thought instead of being
     * asked their genre for the second time. Otherwise it speaks the opening
     * line, and it must be the SAME string Chat shows: two doors on one
     * conversation that open with different words are two features again.
     */
    function greet(): void {
      const messages = sessionRef.current?.messages ?? [];
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      loopRef.current?.greet(lastAssistant?.content ?? OPENING_LINE);
    }
  }, [
    canStart,
    status,
    recordTurns,
    onEnd,
    teardown,
    failVoice,
    setVoicePhase,
    setVoiceRemainingMs,
    setVoiceStatus,
  ]);

  const end = useCallback(() => {
    // Muted first: a stray utterance arriving during teardown must not be
    // posted as a turn against a session that is already over.
    loopRef.current?.setMuted(true);
    setVoiceStatus("ending");
    teardown(null);
  }, [teardown, setVoiceStatus]);

  const retryGesture = useCallback(() => {
    videoRef.current
      ?.play()
      .then(() => setVoiceStatus("live"))
      .catch(() => teardown("video-never-played"));
  }, [setVoiceStatus, teardown]);

  const live = status !== "idle" && status !== "unavailable";

  // Unmount: the door switch, the route change, and the panel swap all land
  // here. Nothing else is needed for those three.
  useEffect(
    () => () => {
      if (loopRef.current !== null) teardown(null);
    },
    [teardown],
  );

  // A hidden tab stops burning the global slot and the monthly minutes. iOS
  // will not grant a microphone to a hidden page either, so this is consistent
  // with what the platform already does.
  useEffect(() => {
    if (!live) return;
    function onVisibility(): void {
      if (document.visibilityState === "hidden") {
        loopRef.current?.setMuted(true);
        hiddenTimer.current = setTimeout(
          () => teardown("hidden-too-long"),
          HIDDEN_GRACE_MS,
        );
      } else {
        if (hiddenTimer.current !== null) clearTimeout(hiddenTimer.current);
        hiddenTimer.current = null;
        loopRef.current?.setMuted(false);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [live, teardown]);

  // `pagehide`, not `beforeunload`: it is the one that fires on iOS's back-
  // forward cache. Best effort only — the lease TTL is the real guarantee.
  useEffect(() => {
    if (!live) return;
    function onPageHide(): void {
      void endVoiceSession();
    }
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [live]);

  return {
    captions,
    pendingTranscript,
    videoRef,
    start,
    end,
    retryGesture,
    canStart,
    supported,
  };
}

/**
 * A refused mint, as a failure and a cooldown.
 *
 * NOTHING HERE AUTO-RETRIES. One press is one attempt. Against a plan with one
 * concurrent session an auto-retry is a lockout loop that also spends the
 * monthly budget — the client would be competing with itself for the slot it
 * just lost.
 */
function mintFailure(error: unknown): [VoiceFailure, number] {
  if (!(error instanceof ApiError)) return ["connect-failed", VOICE_COOLDOWN_MS];

  switch (error.type) {
    case VOICE_NOT_CONFIGURED_TYPE:
      // Voice was never here. The panel goes back to being today's panel, and
      // the cooldown is irrelevant because Talk reverts to Coming Soon.
      return ["not-configured", 0];
    case VOICE_AT_CAPACITY_TYPE: {
      // A REAL number, computed server-side from the live lease — the whole
      // reason the lease exists rather than letting Anam's bare 429 through.
      const retry = error.extras.retry_after_seconds;
      const seconds = typeof retry === "number" && retry > 0 ? retry : 60;
      return ["at-capacity", seconds * 1000];
    }
    case VOICE_QUOTA_EXCEEDED_TYPE:
      return ["quota-exceeded", QUOTA_COOLDOWN_MS];
    default:
      return ["connect-failed", VOICE_COOLDOWN_MS];
  }
}
