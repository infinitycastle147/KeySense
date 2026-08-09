/**
 * The caret. The one thing allowed to move on the test screen — see
 * docs/DESIGN.md §6 ("Test screen: None. Caret only."). Rendered inline within
 * the active word's character flow rather than positioned via DOM measurement,
 * which keeps it cheap enough to redraw on every keystroke.
 */
export function Caret() {
  return (
    <span
      aria-hidden="true"
      className="-mx-px inline-block w-[2px] animate-pulse bg-trace align-middle"
      style={{ height: "1em" }}
    />
  );
}
