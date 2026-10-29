import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AnimatedBackground } from "@/components/AnimatedBackground";
import { Preloader } from "@/components/Preloader";
import { THEME_INIT_SCRIPT } from "@/components/ThemeToggle";
import "@/styles/globals.css";

/**
 * Humanist sans for the interface, serif for report reading mode, monospace
 * for IDs and hashes (PRD 23).
 *
 * WHY THESE ARE SELF-HOSTED RATHER THAN next/font/google
 * `next/font/google` downloads the files at build time, so the build needs to
 * reach fonts.googleapis.com. That turned into a hard blocker three builds in
 * a row: `Failed to fetch Source Serif 4 from Google Fonts`, with the service
 * answering a direct request in 0.5 seconds throughout. It was a corrupt
 * entry in `.next/cache`, and clearing the cache fixed it, which is precisely
 * what makes it worth removing: a build that fails on a network fetch fails
 * in CI, at the worst moment, for a reason that has nothing to do with the
 * change being built.
 *
 * The six files are the variable, latin-only subsets, 381KB in total. The
 * Vietnamese, Cyrillic and latin-ext subsets Google also serves would roughly
 * triple that and this platform needs none of them; `next-intl` is scaffolded
 * for English and a later language would bring its own subset.
 */
const publicSans = localFont({
  src: [
    { path: "./fonts/public-sans.woff2", weight: "100 900", style: "normal" },
    {
      path: "./fonts/public-sans-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-public-sans",
  display: "swap",
});

const sourceSerif = localFont({
  src: [
    { path: "./fonts/source-serif-4.woff2", weight: "200 900", style: "normal" },
    {
      path: "./fonts/source-serif-4-italic.woff2",
      weight: "200 900",
      style: "italic",
    },
  ],
  variable: "--font-source-serif",
  display: "swap",
});

const jetbrainsMono = localFont({
  src: [
    { path: "./fonts/jetbrains-mono.woff2", weight: "100 800", style: "normal" },
    {
      path: "./fonts/jetbrains-mono-italic.woff2",
      weight: "100 800",
      style: "italic",
    },
  ],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "PDDC IIMS",
    template: "%s · PDDC IIMS",
  },
  description:
    "Prima Due Diligence Consult: Intelligence & Investigation Management System.",
  // An investigation platform must never be indexed.
  robots: { index: false, follow: false, nocache: true },
  applicationName: "PDDC IIMS",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Field staff need to zoom into photographs and documents.
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0b1f3a" },
    { media: "(prefers-color-scheme: dark)", color: "#080f1c" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${publicSans.variable} ${sourceSerif.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Applies the stored theme before first paint so a dark-mode user
            never sees a white flash. Must stay blocking and inline. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        <AnimatedBackground />
        <Preloader />
        {children}
      </body>
    </html>
  );
}
