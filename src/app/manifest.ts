import type { MetadataRoute } from "next";

/**
 * PWA manifest. Installable so field investigators get a full-screen app for
 * check-ins, quick activity notes and camera capture (PRD §18 screen 25).
 *
 * Note what this does NOT do: the service worker never caches an
 * authenticated or investigative route. See public/sw.js.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PDDC Intelligence & Investigation Management System",
    short_name: "PDDC IIMS",
    description:
      "Case, evidence and intelligence management for Prima Due Diligence Consult.",
    start_url: "/dashboard",
    display: "standalone",
    orientation: "any",
    background_color: "#0b1f3a",
    theme_color: "#0b1f3a",
    categories: ["business", "productivity", "security"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      { name: "My tasks", url: "/tasks" },
      { name: "Safety check-in", url: "/safety" },
      { name: "Log activity", url: "/activities/new" },
    ],
  };
}
