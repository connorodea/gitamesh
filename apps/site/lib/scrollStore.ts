// ---------------------------------------------------------------------------
// A single, module-level scroll store.
//
// Every scroll-driven system on this page (camera rig, constellation spread,
// the readability scrim, the nav's condensed state) reads from ONE mutable
// object that a single passive listener writes to. Nothing here ever touches
// React state, so scrolling the page never schedules a render — the r3f frame
// loop and a couple of CSS custom properties are the only consumers.
//
// Two progress scalars are published:
//
//   hero  0 -> 1 across the first viewport, for hero-local choreography
//         (headline parallax, entrance-to-departure of the opening act).
//   page  0 -> 1 across the whole scrollable document, for the four-act
//         camera track in CameraRig.tsx.
//
// Apache-2.0 · github.com/connorodea/gitamesh
// ---------------------------------------------------------------------------

export type ScrollState = {
  /** Raw scroll offset in px. */
  y: number;
  /** Viewport height in px (cached; recomputed on resize). */
  vh: number;
  /** 0..1 across the first viewport height. */
  hero: number;
  /** 0..1 across the full scrollable range of the document. */
  page: number;
};

/**
 * The live store. Deliberately a mutable singleton rather than context: the
 * r3f render loop reads it every frame and must not be coupled to React's
 * scheduler.
 */
export const scrollState: ScrollState = { y: 0, vh: 1, hero: 0, page: 0 };

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Recompute every derived scalar from the current document scroll position. */
export function measureScroll(y = window.scrollY): void {
  const vh = window.innerHeight || 1;
  const docHeight = document.documentElement.scrollHeight;
  const range = Math.max(1, docHeight - vh);

  scrollState.y = y;
  scrollState.vh = vh;
  scrollState.hero = clamp01(y / vh);
  scrollState.page = clamp01(y / range);
}

/**
 * Mirror scroll-derived values onto CSS custom properties so purely
 * presentational layers (the canvas readability scrim, the hero's fade-out)
 * can be driven by the same numbers without a React re-render.
 *
 * `--scrim` ramps the dark overlay in front of the WebGL stage as the reader
 * leaves the hero, guaranteeing body-copy contrast over the live scene
 * regardless of what the constellation happens to be doing behind it.
 */
export function publishScrollVars(): void {
  const root = document.documentElement;

  // Ramp in as the reader leaves the hero and the copy takes over...
  const rise = clamp01((scrollState.hero - 0.15) / 0.6);

  // ...then ease partly back out across the final stretch. The closing act of
  // the camera track rises into a near-isometric read of the mesh above its
  // lattice field, and that is the scene's payoff — holding the scrim at full
  // strength would render it invisible. The release is partial (never below
  // ~0.65 of full) because the quickstart copy still has to stay legible; the
  // terminal block and footer carry their own opaque surfaces, so the risk is
  // limited to the caption beneath them.
  const release = 1 - clamp01((scrollState.page - 0.78) / 0.22) * 0.35;

  root.style.setProperty("--scrim", (rise * release).toFixed(3));
  root.style.setProperty("--hero-progress", scrollState.hero.toFixed(3));
}
