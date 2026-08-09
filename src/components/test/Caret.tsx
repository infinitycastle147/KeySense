/**
 * The caret. The one thing allowed to move on the test screen — see
 * docs/DESIGN.md §6 ("Test screen: None. Caret only."). Rendered inline within
 * the active word's character flow rather than positioned via DOM measurement,
 * which keeps it cheap enough to redraw on every keystroke.
 *
 * Two things here are load-bearing, both fixing measured misalignment:
 *
 *   `self-center` — the parent Word is a flex container, and flex items ignore
 *   `vertical-align`. The caret previously carried `align-middle`, which
 *   computed but did nothing: it sat flush to the top of the 52px line box
 *   instead of centred on the glyph, roughly 10px high.
 *
 *   `-mr-[2px]` rather than a negative left margin — the caret must occupy zero
 *   horizontal space so it never shifts the characters around it, but it has to
 *   do that by pulling in its *trailing* edge. Cancelling on the left instead
 *   put its stroke a pixel to the left of the character boundary it marks.
 */
export function Caret() {
  return (
    <span
      aria-hidden="true"
      className="h-[1.1em] w-[2px] -mr-[2px] self-center animate-pulse bg-trace"
    />
  );
}
