/**
 * The suggestion pools the Home and Create surfaces shuffle through.
 *
 * WRITTEN FOR ACE-STEP, not for reading pleasure. The server takes a single
 * free-text `caption` (worker/worker/inference.py) and conditions on dense
 * descriptors — genre, instrumentation, texture, groove. It does NOT parse
 * instructions, so none of these open with "create a song about…": that wrapper
 * conditions the model on nothing and is exactly what `trackTitle` has to peel
 * back off to name the track.
 *
 * Each prompt's FIRST CLAUSE is also its derived title, so every entry leads
 * with the words worth naming the track after.
 */
export const PROMPT_SUGGESTIONS: readonly string[] = [
  "Dreamy lo-fi with warm piano and soft rain",
  "Upbeat synthwave for a midnight drive",
  "Cinematic orchestral build with epic drums",
  "Slow jazz trio with brushed snare and upright bass",
  "Ambient drone with granular textures and deep reverb",
  "Boom-bap hip-hop with dusty drums and muted horns",
  "Acoustic folk ballad with fingerpicked guitar",
  "Driving techno with a rolling bassline and tight hats",
  "Warm bossa nova with nylon guitar and shaker",
  "Trailer percussion with choir swells and brass stabs",
  "Chillwave with hazy synth pads and reverbed guitar",
  "Funk groove with slap bass and clavinet stabs",
  "Melancholic piano solo with distant strings",
  "Tropical house with plucked synths and steel drums",
  "Dark industrial beat with metallic percussion",
  "Country road song with slide guitar and honky-tonk piano",
  "Neo-soul groove with Rhodes piano and silky vocals",
  "Retro chiptune with driving arpeggios",
  "Flamenco guitar with handclaps and cajón",
  "Ethereal choir over sub bass and slow strings",
] as const;

/**
 * Lowercase on purpose: `addInstrument` lowercases every entry before storing
 * it, so a capitalised pool would make the "already added" filter miss.
 */
export const INSTRUMENT_SUGGESTIONS: readonly string[] = [
  "piano",
  "electric guitar",
  "acoustic guitar",
  "synth pads",
  "strings",
  "drums",
  "bass",
  "saxophone",
  "vinyl crackle",
  "rhodes piano",
  "upright bass",
  "brushed snare",
  "trumpet",
  "cello",
  "flute",
  "harp",
  "808 bass",
  "hammond organ",
  "marimba",
  "choir",
] as const;
