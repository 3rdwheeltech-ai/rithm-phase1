import {
  GENRES,
  MOODS,
  type Genre,
  type LyricsMode,
  type Mood,
  type SongDraft,
  type Voice,
} from "../types/api";

/**
 * What the assistant opens with, in ONE place.
 *
 * Lifted out of `ChatPanel` because there are two doors onto this conversation
 * now and they must say the same words. Two doors on one conversation that
 * open with different greetings are two features again — and the voice door
 * speaks this string aloud where the chat door renders it, so a drift here is
 * a drift the user can hear.
 *
 * NO EM-DASH, deliberately. This is the first thing the avatar ever says, and
 * the TTS engine has no word for one — `sanitizeForSpeech` would rewrite it to
 * a comma anyway, so the two doors would open with different punctuation.
 */
export const OPENING_LINE =
  "Tell me about the song you want. A scene, a feeling, anything at all.";

/**
 * The Create form's initial state, in one place.
 *
 * These are the values the form opens with when nothing has been handed to it,
 * lifted out of the useState initialisers so the handoff path and the cold
 * path cannot disagree about what "empty" means.
 */
export interface CreateFormState {
  complexity: "simple" | "advanced";
  lyricMode: LyricsMode;
  prompt: string;
  title: string;
  voice: Voice;
  lyrics: string;
  lyricPrompt: string;
  genre: Genre | "";
  mood: Mood | "";
  instruments: string[];
  lengthSeconds: number;
  tempoAuto: boolean;
  bpmMin: number;
  bpmMax: number;
}

export const CREATE_FORM_DEFAULTS: CreateFormState = {
  complexity: "simple",
  // Write is the landing state: the lyrics editor is why most people open the
  // page, and an empty box still means "you write the words".
  lyricMode: "write",
  prompt: "",
  title: "",
  voice: "auto",
  lyrics: "",
  lyricPrompt: "",
  genre: "",
  mood: "",
  instruments: [],
  lengthSeconds: 90,
  tempoAuto: true,
  bpmMin: 90,
  bpmMax: 130,
};

/** Genre and mood are narrowed rather than trusted — see the module note below. */
function asGenre(value: string | null): Genre | "" {
  return value !== null && (GENRES as readonly string[]).includes(value)
    ? (value as Genre)
    : "";
}

function asMood(value: string | null): Mood | "" {
  return value !== null && (MOODS as readonly string[]).includes(value) ? (value as Mood) : "";
}

/**
 * A chat draft as Create form state. THE single place the wire invariants are
 * honoured on the handoff.
 *
 * The server has already clamped every value (its SongDraft mirrors
 * GenerateRequest's bounds exactly), so this is a mapping and not a second
 * round of validation. What it still has to get right is the handful of
 * relationships the form expresses differently from the wire:
 *
 * - `instrumental` is not a field here; it is `lyricMode === "instrumental"`,
 *   and the form derives `vocal` from it at submit.
 * - `voice` is forced to "auto" for an instrumental. The API normalises it
 *   anyway, but a leftover "female" showing in a disabled control reads as the
 *   form having ignored the conversation.
 * - `tempoAuto` is the ABSENCE of a bpm range, not a value in one. The pair is
 *   both-or-neither on the wire, so one non-null half is enough to turn the
 *   slider on — and the server never sends half a range.
 * - genre/mood are narrowed against the local vocabulary. The server validates
 *   against its own copy, so this can only fire if the two have drifted — and
 *   a value the select has no option for renders as a blank field, which reads
 *   as the handoff having lost it.
 *
 * `prompt` is the second argument because `QuickGenerate`'s existing "Write
 * lyrics" door hands over a bare prompt string and no draft, and that path
 * keeps working unchanged.
 */
export function draftToCreateState(
  draft: SongDraft | null,
  prompt?: string,
): CreateFormState {
  if (draft === null) {
    return { ...CREATE_FORM_DEFAULTS, prompt: prompt ?? CREATE_FORM_DEFAULTS.prompt };
  }

  const lyricMode: LyricsMode = draft.lyrics_mode ?? CREATE_FORM_DEFAULTS.lyricMode;
  const instrumental = lyricMode === "instrumental";
  const genre = asGenre(draft.genre);
  const mood = asMood(draft.mood);
  const tempoAuto = draft.bpm_min === null || draft.bpm_max === null;
  const voice: Voice = instrumental ? "auto" : (draft.voice ?? CREATE_FORM_DEFAULTS.voice);

  return {
    // Open on Advanced when the draft carries something Simple cannot show.
    // Otherwise the user lands on a form that appears to have ignored half the
    // conversation — the fields are there, just one tab away and invisible.
    complexity:
      genre !== "" || mood !== "" || !tempoAuto || voice !== "auto" ? "advanced" : "simple",
    lyricMode,
    prompt: draft.prompt ?? prompt ?? CREATE_FORM_DEFAULTS.prompt,
    title: draft.title ?? CREATE_FORM_DEFAULTS.title,
    voice,
    // Two separate boxes, matching the form: switching Write→Prompt→Write must
    // not hand a half-written verse to the lyricist as if it were a brief.
    lyrics: instrumental ? "" : (draft.lyrics ?? ""),
    lyricPrompt: instrumental ? "" : (draft.lyrics_prompt ?? ""),
    genre,
    mood,
    instruments: draft.instruments,
    lengthSeconds: draft.length_seconds ?? CREATE_FORM_DEFAULTS.lengthSeconds,
    tempoAuto,
    bpmMin: draft.bpm_min ?? CREATE_FORM_DEFAULTS.bpmMin,
    bpmMax: draft.bpm_max ?? CREATE_FORM_DEFAULTS.bpmMax,
  };
}
