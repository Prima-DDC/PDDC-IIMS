"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Liquid-glass metamorphic header.
 *
 * Translucent with blur and saturation, and it *morphs* on scroll: it loses
 * height, gains opacity and picks up a shadow, so the page feels like it is
 * sliding underneath glass rather than under a flat bar. The transition is a
 * CSS property animation on tokens defined in globals.css, so it costs nothing
 * on the main thread and disappears under prefers-reduced-motion.
 */
export function GlassTopBar({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    // Passive: this must never delay scrolling on a long evidence table.
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`glass sticky top-0 z-30 border-b border-line ${
        scrolled ? "glass-scrolled h-14" : "h-16"
      }`}
    >
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-3 px-4 sm:px-6">
        {children}
      </div>
    </header>
  );
}
