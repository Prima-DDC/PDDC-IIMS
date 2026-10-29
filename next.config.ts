import type { NextConfig } from "next";

/**
 * Evidence and document files never travel through a server action or route
 * handler: Vercel caps function request bodies at 4.5 MB, so uploads go
 * direct to Supabase Storage over resumable TUS and are hash-verified
 * asynchronously (see docs/architecture.md, "Evidence upload and hashing").
 * The modest limit here is for ordinary forms only.
 */
const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
    // Required by forbidden() and unauthorized(), which the administration
    // screens use to render a real 403 rather than pretending a page does not
    // exist. Still flagged experimental in Next 16, but it is the documented
    // way to return 403 from a server component, and the alternative (404 for
    // an authorisation failure) hides a correctable problem from the user.
    authInterrupts: true,
  },

  // Investigative content must never be cached by a shared cache (PRD §21.3).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            // Field mode needs the camera for evidence capture; nothing else.
            value: "camera=(self), microphone=(), geolocation=(self)",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: `${process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF ?? "*"}.supabase.co`,
        pathname: "/storage/v1/object/**",
      },
    ],
  },
};

export default nextConfig;
