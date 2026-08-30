# Interview knowledge base — vocabularies, bounds, and structured fields

## What this document is

This is the full data model behind the RITHM song interview: the exact
vocabularies, value bounds, field relationships, and question ordering that
back the conversational persona which interviews a user about the song they
want made. It stands on its own — everything a reader needs to understand
the data this interview collects is written out here in full, not pointed at
elsewhere.

**Context, briefly:** the interview is conducted by an assistant persona
(named Rithm) over both a spoken voice surface and a plain-text chat
surface, driven by the exact same backend logic either way. As the
conversation goes, answers are folded into a single running record
describing the song — a genre from a closed list, a mood from a closed
list, an optional lyric direction, instruments, length, and so on. That
record is what eventually pre-fills a real form the user reviews before
generation starts. Nothing here is ever shown to the user as raw data —
it's translated into natural conversation on the way out, and the record
itself is only ever built up silently in the background.

## The two closed vocabularies

Genre and mood are the two fields that must land on an exact match from a
fixed list — nothing else is accepted as a final value. Matching is
case-insensitive, but the value that ends up recorded is always written in
the canonical capitalization shown below. If an answer doesn't match
anything on the list, it is treated as "not yet answered" rather than
recorded incorrectly — the assistant is expected to actively map an
off-list answer onto the nearest real option and say so, rather than let it
silently fall through.

**Genre — nine options:**

```
Pop
Hip-Hop
EDM
Lo-Fi
Cinematic
Rock
Country
R&B
Ambient
```

**Mood — seven options:**

```
Happy
Calm
Energetic
Dark
Romantic
Inspirational
Dramatic
```

Example mappings an interviewer should make automatically, without asking
for confirmation: "synthwave" or "house" → EDM; "chillhop" or "study
beats" → Lo-Fi; "orchestral" or "film score" → Cinematic; "sad" or
"melancholy" → Dark; "uplifting" or "hopeful" → Inspirational; "chill" or
"relaxed" → Calm.

## The full field list, with bounds and meaning

| Field | What it holds | Bound / allowed values | Notes |
|---|---|---|---|
| Style | One-sentence free-text description of the music | Up to roughly 2000 characters | The single most important field — a scene, feeling, or reference. First of the three fields that unlock the destination screen. Shown on the eventual form under a "Styles" / "Describe the track" heading. |
| Title | The track's name | Up to roughly 80 characters | Only set if the user volunteers a name. Never asked for proactively. |
| Genre | One of the nine closed genre options above | Exact match only | Second of the three fields that unlock the destination screen. |
| Mood | One of the seven closed mood options above | Exact match only | Third of the three fields that unlock the destination screen. |
| Vocals mode | Whether the track is sung with literal words, sung from a described direction, or fully instrumental | One of: "write" (the user supplied literal words), "prompt" (the user described a direction, words to be generated from it), "instrumental" (no vocals at all) | Drives which of the two lyric-related fields below is used, if either. |
| Voice | Which vocal lead to use | One of: "auto" (RITHM's choice), "female," "male" | Meaningless, and forced to "auto," whenever the track is instrumental. |
| Lyrics (literal) | The user's own words, verbatim | Up to roughly 3000 characters | Only ever the user's actual words — the assistant never invents lyrics into this field unprompted. Only used when vocals mode is "write." |
| Lyric direction (brief) | A prose description of what the lyrics should be about | Up to roughly 600 characters | Used to generate lyrics from, rather than supplying them directly. Only used when vocals mode is "prompt." Shown on the eventual form under a "What the song is about" heading. |
| Instruments | A short list of instrument names | Up to 10 items, each up to roughly 40 characters, deduplicated | Free text — not a closed vocabulary — but a common recognition list is used to catch typical answers; see below. |
| Length | Track duration in seconds | Roughly 10 to 180 seconds (up to 3 minutes) | |
| Tempo (BPM range) | A minimum and maximum beats-per-minute | Roughly 20 to 300, both ends present together or neither | Never proactively asked about — only discussed if the user raises tempo themselves. If given out of order, the lower and higher values are simply swapped into the right order rather than treated as an error. |

### Field relationships that are always kept consistent

These relationships are enforced automatically whenever the record is
updated, so a conversation can never leave it in a contradictory state:

- If vocals mode is **instrumental**: both the literal lyrics field and the
  lyric-direction brief are cleared, and the voice field is forced back to
  "auto" — a vocal gender choice makes no sense on a track with no singer.
- If vocals mode is **"write"** (literal words supplied): the lyric-direction
  brief is cleared, since a full set of literal words makes a separate
  prose brief redundant.
- If vocals mode is **"prompt"** (a direction was described instead): the
  literal lyrics field is cleared, since no literal words were actually
  given.
- The tempo range is only ever recorded as a complete pair — if only one
  end of the range is known, neither is kept; a single number isn't a
  usable tempo range on its own. And if a lower bound and upper bound come
  in reversed, they are simply swapped rather than surfaced as an error.

### When there's enough to open the destination screen

The rule for "there's enough to move forward" is intentionally narrow and
based on exactly three fields: **style, genre, and mood.** As soon as all
three are known, the destination screen becomes available — nothing else
is required to unlock it, and this determination is made from the actual
collected values, never from the assistant's own sense of whether the
conversation "feels" finished.

This bar is deliberately kept low. Vocals mode was tried, at one point in
this design's history, as a fourth required field, and dropped again: it
has a sensible default (treat it as "write," i.e. sung with generated
words, unless told otherwise) and holding the destination screen closed for
it would cost an entire extra conversational turn for something that, once
the screen is open, is answerable as a simple two-option toggle anyway.

## The order questions are asked in

The interview proceeds down a fixed ladder of steps, always in this order:

```
1. style
2. genre
3. mood
4. vocals mode
5. voice          (skipped entirely when vocals mode is instrumental)
6. instruments
7. length
```

Tempo and title sit **off** this ladder entirely — they are never asked
about as part of the normal progression, only discussed if the user brings
them up unprompted.

The first three steps are the ones that gate the destination screen, so
they are asked until answered. Every step from "vocals mode" onward is
asked **at most once** — if the user waves a question away with something
like "whatever" or "you pick," that still counts as the question having
been put, and the interview does not return to it a second time. This
matters because several of these answers (a brushed-off vocals question, an
unspecified instrument list) leave the underlying field empty or at a
default — if the ladder waited for a "real" value before considering the
step done, a conversation full of brush-offs could get stuck one step short
of finishing even though the user has clearly signaled they're done
answering that kind of question.

Recognizing that a given step has already been asked (so it isn't repeated)
is done by noticing characteristic words in the assistant's own most recent
question:

| Step | Recognized by words like |
|---|---|
| genre | "genre," "style" |
| mood | "mood" |
| vocals mode | "sung," "instrumental," "vocals," "singing" |
| voice | "voice," "sing it," "sings it," "female," "male" |
| instruments | "instruments," "instrumentation," "line-up," "lineup" |
| length | "how long," "length," "seconds," "minute" |

## One-tap suggestion chips per step

Alongside each question, a small set of one-tap answer suggestions is
offered, so a user can respond with a single tap instead of typing or
speaking:

| Step | Suggested chips |
|---|---|
| genre | Lo-Fi, EDM, Cinematic |
| mood | Calm, Energetic, Dark |
| vocals mode | Sung, Instrumental |
| voice | Female, Male, Surprise me |
| instruments | Piano, Guitar, Whatever fits |
| length | 30 seconds, 1 minute, 2 minutes |

Each of these chips is phrased so it can be understood as a plain-language
answer on its own, independent of any particular recognition system — "the
chip text itself is a valid conversational reply."

## Instrument recognition vocabulary

Instruments are free text, not a closed vocabulary like genre or mood — a
user can name anything. The following list represents the common, expected
answers, matched longest-phrase-first so that a two-word instrument like
"rhodes piano" is recognized as itself rather than being partially matched
as plain "piano":

```
electric guitar, acoustic guitar, upright bass, hammond organ,
brushed snare, vinyl crackle, rhodes piano, synth pads, saxophone,
808 bass, marimba, trumpet, strings, guitar, violin, drums, piano,
cello, choir, flute, organ, synth, bass, harp
```

A user naming something outside this list is still recorded verbatim —
this list exists to make common answers easy to recognize automatically,
not to restrict what's allowed.

## Behavioral guardrails that shape the collected data

- Off-list genre or mood answers are always mapped to the nearest real
  option and named explicitly in the reply — never invented as a new
  category, and never left for the user to separately confirm.
- Literal lyrics are only ever the user's own words. The assistant does not
  invent full lyrics and drop them into that field.
- A brief for lyric direction is prose describing what the song should be
  about — not literal words, and it's cleared automatically the moment
  literal lyrics are supplied instead (and vice versa), so the two never
  coexist in a way that would be contradictory.
- Nothing here is ever surfaced to the user as "data," a "field," a
  "schema," or "JSON" — all of the above happens silently in the
  background while the surface conversation stays natural and unaware of
  its own machinery.

## How answers get turned into this structured record

Two separate jobs happen on every turn of the conversation, deliberately
kept apart from each other:

1. **Holding the conversation** — deciding what to say next, in natural,
   warm, on-brand language, given everything already known about the song.
2. **Extracting structured values** — reading the same exchange and
   deciding what (if anything) should be added to or changed in the
   structured record above.

These two jobs are handled as genuinely separate steps rather than asking
one process to both converse naturally *and* reliably emit structured data
in the same breath — asking for both at once tends to produce either
stiff, robotic conversation or unreliable structured output, and often
both. The structured-extraction step is run at the lowest "creativity"
setting available (effectively zero), because consistency and correctness
matter far more than variety when the entire point of the step is to
produce a strictly and predictably formatted result. When nothing new was
actually said, or an extraction genuinely fails, the correct behavior is to
add nothing — leaving a field unanswered is always the safer failure than
guessing and recording something wrong, since a wrong guess is invisible to
the user until it turns up already filled in on the destination screen.
