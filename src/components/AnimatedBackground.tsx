/**
 * The "alive" background: a slow aurora wash behind a faint evidence grid.
 *
 * Deliberately restrained. This sits behind dense tables and report text that
 * people read for whole shifts, so the aurora runs over 22-34 second cycles
 * at low opacity and the grid pans over a full minute. It is present when you look
 * for it, invisible when you are working. Pure CSS, so it costs no JavaScript
 * and stops entirely under prefers-reduced-motion.
 */
export function AnimatedBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      <div className="absolute inset-0 bg-canvas" />

      {/* Aurora wash. Three blobs on different cycles never visibly loop. */}
      <div className="absolute -top-1/3 -left-1/4 size-[70vw] animate-aurora-a rounded-full bg-signal/[0.07] blur-3xl" />
      <div className="absolute top-1/4 -right-1/4 size-[60vw] animate-aurora-b rounded-full bg-ink-soft/[0.09] blur-3xl" />
      <div className="absolute -bottom-1/4 left-1/4 size-[55vw] animate-aurora-c rounded-full bg-class-public/[0.06] blur-3xl" />

      {/* Evidence grid, drifting. The motif that says "case file". */}
      <div className="absolute inset-0 animate-grid-pan bg-evidence-grid" />

      {/* Vignette keeps the centre calm where the content sits. */}
      <div className="absolute inset-0 bg-radial-[at_50%_40%] from-transparent to-canvas/70" />
    </div>
  );
}
