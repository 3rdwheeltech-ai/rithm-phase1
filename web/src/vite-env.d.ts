/// <reference types="vite/client" />

/*
 * Vite's ambient module declarations, which are what make `import portrait
 * from "../assets/ria-portrait.webp"` type-check.
 *
 * tsconfig.json sets no `types` array, so every @types package is in scope
 * already — but Vite ships its asset declarations behind this reference rather
 * than in a package TypeScript picks up on its own. Without this file the
 * image import is a TS2307 and `npm run build` fails while `npm run dev`
 * happily serves it, which is the worst version of that bug to discover.
 */
