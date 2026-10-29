import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * PRD §21.1 requires dependencies to point inward only, with the domain layer
 * free of any framework or database import. That is enforced here rather than
 * merely documented: a boundary violation fails the build.
 *
 *   app/ + features/  ->  may import a module's public index only
 *   application/      ->  may import its own domain and ports
 *   domain/           ->  may import nothing outside itself
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    // The domain layer is pure TypeScript: entities, value objects, state
    // machines and policies. No React, no Next, no SQL, no SDKs.
    files: ["src/modules/*/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "next",
                "next/*",
                "react",
                "react-*",
                "@supabase/*",
                "postgres",
                "drizzle-orm",
                "drizzle-orm/*",
                "resend",
                "@/lib/*",
                "@/app/*",
                "@/features/*",
                "@/components/*",
                "**/infrastructure/**",
                "**/application/**",
              ],
              message:
                "The domain layer must not import frameworks, databases, SDKs or outer layers (PRD §21.1).",
            },
          ],
        },
      ],
    },
  },

  {
    // Use cases orchestrate the domain through ports. They must not reach for
    // a concrete adapter, or the port abstraction is pointless.
    files: ["src/modules/*/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/infrastructure/**", "@/app/*", "@/features/*", "@/components/*"],
              message:
                "The application layer talks to infrastructure only through ports (PRD §21.1).",
            },
          ],
        },
      ],
    },
  },

  {
    // Presentation composes modules through their public surface. Reaching
    // into a module's internals couples the UI to its implementation.
    files: ["src/app/**/*.{ts,tsx}", "src/features/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/modules/*/domain/*",
                "@/modules/*/domain/**",
                "@/modules/*/application/*",
                "@/modules/*/application/**",
                "@/modules/*/infrastructure/*",
                "@/modules/*/infrastructure/**",
              ],
              message:
                "Import a bounded context through its public surface only: @/modules/<context> on the server, or @/modules/<context>/shared from a client component (PRD §21.1).",
            },
            {
              // Next prefetches every <Link> in view, which for this platform
              // meant one server render per sidebar destination, per case tab
              // and per table row, on every page view. It did not read as
              // slowness: it read as a form that saved the record and never
              // said so. @/components/AppLink is the same component with
              // prefetching off by default, and a link that genuinely wants
              // it can pass `prefetch` and say why. See AppLink for the
              // measurements.
              group: ["next/link"],
              message:
                "Import AppLink from @/components/AppLink instead of next/link: prefetching every link cost one full server render per link on every page view.",
            },
          ],
        },
      ],
    },
  },

  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "supabase/functions/**"]),
]);

export default eslintConfig;
