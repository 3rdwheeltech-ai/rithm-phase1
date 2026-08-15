/**
 * Album art, for an app that has none.
 *
 * Generated tracks carry no image and nothing in the API produces one, so a
 * stock photograph stands in, with a gradient underneath it. Both are derived
 * from the track id, so a track keeps the same face across sessions rather than
 * shuffling on every render — and neither is stored anywhere, because a pure
 * function of a UUID the API already returns needs no column and no cache.
 *
 * The gradient is not vestigial: it is what shows when the photo is still
 * loading, when the CDN is blocked, or when a URL dies. See CoverArt.tsx.
 */

import COVERS from "../data/covers.json";

/**
 * DO NOT reorder or extend this array.
 *
 * `coverGradient` is `hash % GRADIENTS.length`, so changing the length re-faces
 * every track every user already owns — a silent, unreviewable change to
 * content people recognise. New gradients belong in DEMO_GRADIENTS below.
 */
const GRADIENTS = [
  "from-teal-400/45 via-cyan-600/35 to-slate-900/65",
  "from-amber-400/45 via-orange-600/35 to-rose-950/60",
  "from-emerald-400/40 via-teal-600/40 to-slate-900/70",
  "from-sky-400/40 via-teal-600/35 to-indigo-950/60",
  "from-amber-300/40 via-yellow-700/30 to-teal-950/70",
  "from-cyan-300/45 via-sky-700/35 to-slate-900/65",
  "from-orange-400/40 via-amber-700/35 to-slate-950/65",
];

export function coverGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 997;
  return GRADIENTS[hash % GRADIENTS.length]!;
}

/**
 * A wider palette for Discover's sample catalogue.
 *
 * Separate from GRADIENTS on purpose. Discover shows twenty-odd covers at once
 * and seven faces would read as a pattern rather than a catalogue; keeping them
 * apart buys that variety without touching what a real track looks like.
 *
 * Still within the room's palette — teal, amber and the cool end — so a browse
 * page does not look like it belongs to a different product.
 */
const DEMO_GRADIENTS = [
  "from-teal-300/55 via-cyan-700/40 to-slate-950/75",
  "from-amber-300/55 via-rose-700/35 to-slate-950/75",
  "from-violet-400/45 via-indigo-700/40 to-slate-950/75",
  "from-emerald-300/50 via-teal-700/40 to-slate-950/75",
  "from-orange-300/55 via-amber-800/35 to-neutral-950/75",
  "from-sky-300/50 via-blue-800/35 to-slate-950/75",
  "from-rose-300/45 via-fuchsia-800/35 to-slate-950/75",
  "from-lime-300/40 via-emerald-800/40 to-slate-950/75",
  "from-cyan-200/50 via-teal-800/40 to-neutral-950/75",
  "from-yellow-200/45 via-orange-700/35 to-stone-950/75",
  "from-indigo-300/45 via-violet-800/35 to-slate-950/75",
  "from-teal-200/45 via-emerald-700/35 to-zinc-950/75",
  "from-red-300/40 via-rose-800/35 to-slate-950/75",
  "from-blue-300/45 via-cyan-800/40 to-slate-950/75",
];

/** Stable cover for a sample item, by its position in the catalogue. */
export function demoGradient(index: number): string {
  return DEMO_GRADIENTS[index % DEMO_GRADIENTS.length]!;
}

/**
 * The photograph for a track, hotlinked from Unsplash.
 *
 * DO NOT change the length of covers.json. Same reason as GRADIENTS above:
 * this is `hash % length`, so adding an 78th entry silently re-faces every
 * cover every user already recognises. Replacing a dead url *in place* at a
 * fixed `n` is the supported edit; appending is not.
 *
 * Every url in that file was verified to return 200 image/jpeg when it was
 * written, but they are third-party and unversioned — one dying is a matter of
 * when, not if, which is why the caller always keeps the gradient underneath.
 */
export function coverImage(seed: string): string | undefined {
  if (COVERS.length === 0) return undefined;
  // FNV-1a, deliberately not coverGradient's multiply-by-31: two different
  // hashes keep a track's photo uncorrelated with its fallback gradient, so
  // the seven tracks sharing a gradient do not also share a photo.
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return COVERS[(hash >>> 0) % COVERS.length]!.url;
}
