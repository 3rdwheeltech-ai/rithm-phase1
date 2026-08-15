import { useState } from "react";
import { cn } from "../lib/cn";
import { coverGradient, coverImage } from "../lib/covers";

/**
 * A track's cover: a stock photograph over the gradient that used to be the
 * whole story.
 *
 * The gradient is always painted, and the image sits on top of it. That is the
 * entire fallback design — a url that 404s, a CDN that is blocked, a network
 * that has not answered yet all resolve to what the app looked like before
 * there were photographs, with no broken-image icon, no layout shift and no
 * empty square in between.
 *
 * Sizing and shape are the caller's, matching TrackCard's convention: the
 * player wants a 40px circle, the detail page a 220px card, the Library grid
 * whatever the cell says.
 */
export default function CoverArt({
  seed,
  gradient,
  className,
}: {
  /** Track id. Both the photo and the fallback gradient are derived from it. */
  seed: string;
  /**
   * Overrides the gradient under the photo. Discover passes `demoGradient`, so
   * its sample catalogue keeps its own wider palette when an image is missing.
   */
  gradient?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const url = coverImage(seed);

  // A span, not a div: the player's mini thumb lives inside a <button>, whose
  // content model is phrasing only. `block` makes it behave like the div it
  // replaced everywhere else.
  return (
    <span
      className={cn(
        "relative block overflow-hidden bg-gradient-to-br",
        gradient ?? coverGradient(seed),
        className,
      )}
    >
      {url && !failed && (
        <img
          src={url}
          // Decorative: the title is adjacent text at every call site, so
          // announcing the photograph would only repeat it.
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-300",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </span>
  );
}
