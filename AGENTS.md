<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes: APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

Notably: `middleware.ts` is now **`proxy.ts`**, and React 19's
`react-hooks/set-state-in-effect` rule is an **error**: reading browser
storage belongs in `useSyncExternalStore`, not an effect.

# PDDC IIMS: working rules

## The one thing that must never break

This project shares a Supabase database with the **live primaddc.com website**
(project ref `iccbchzopnomagcqbhqe`). The website owns the `public` schema
entirely.

- **Never run DDL against `public`, `auth` or `storage`.** The IIMS owns ten
  schemas: `iam crm casework intel evidence docs reporting audit notify config`.
- **Migrations are tracked in `config._migrations`**, never
  `public._migrations`: that is the website's ledger, and sharing it would
  corrupt both histories.
- `iims_app` may hold privileges only inside the ten IIMS schemas, plus
  `SELECT` on `public.profiles`, `auth.users` and `auth.sessions`.
- Run `npm run check:coexistence` after any migration. It asserts all of the
  above and fails the build on a violation.
- Validate first: `node --env-file=.env.local scripts/validate-migrations.mjs`
  applies pending migrations in a transaction and **always rolls back**.

## Data access

- **All case data** goes through `withActor()` in `src/lib/db/client.ts`, which
  opens a transaction and publishes the actor as transaction-local settings for
  RLS and the audit triggers to read.
- **Never** use `supabase-js` or the service-role key to read or write case
  data: both bypass RLS, which would void the classification model and the
  append-only audit guarantee (PRD §13). supabase-js is for auth, storage and
  realtime only.
- Every table gets `ENABLE` **and** `FORCE ROW LEVEL SECURITY`. Without FORCE,
  `postgres` (which owns every table) silently ignores its own policies.
- Policies **fail closed**: `nullif(current_setting('iims.user_id', true), '')::uuid`.
  Never write a `coalesce(..., 'something')` fallback.
- Extension functions are always schema-qualified (`extensions.digest`,
  `extensions.similarity`) because trigger functions pin `search_path = ''`.
  The pg_trgm `%` operator is unusable there: use `extensions.similarity()`.

## Architecture (enforced by eslint, not just documented)

```
app/ + features/  ->  may import a bounded context ONLY via @/modules/<name>
modules/*/application  ->  own domain + ports; never infrastructure
modules/*/domain       ->  nothing outside itself: no React, Next, SQL or SDKs
```

A boundary violation is a lint error and therefore a failed build. `features/*`
holds presentation (flat, co-located: `actions.ts`, `queries.ts`, `schema.ts`,
`PascalCase.tsx`), matching the prima-website-2.0 convention.

## UI

- Tailwind v4, CSS-first. All tokens live in `src/styles/globals.css` under
  `@theme`; there is no `tailwind.config`.
- Semantic tokens indirect through `--p-*` palette variables, so `data-theme`
  flips the whole app. Use `bg-surface`, `text-muted`, `text-risk-high`: never
  a raw hex value.
- Motion is **pure CSS keyframes**, declared as `--animate-*` tokens. No
  animation library. Everything must collapse under `prefers-reduced-motion`.
- Navigation items carry an **icon name** (`NAV_ICONS`), not a component:
  nav is built on the server and must survive serialisation.
- `localStorage` holds UI preferences only. Never tokens, evidence, subject
  names, findings or report text (PRD §21.3).

## Known platform constraints

| Constraint | Consequence |
| --- | --- |
| Vercel caps function bodies at 4.5 MB | Evidence uploads go direct to Storage; hashes are client-declared then server-verified by a worker |
| Supabase free tier caps objects at 50 MB | Large media does not fit; needs Pro |
| `ban_duration` does not revoke live sessions | Suspension is enforced per request in `iam` |
| No account lockout in Supabase Auth | Failed-attempt counter lives in `iam` |
| Transaction-mode pooler forbids prepared statements | `postgres.js` is configured `prepare: false` |
| Supabase signs Postgres certs with its own CA | Pinned in `src/lib/db/supabase-ca.ts`; never set `rejectUnauthorized: false` |

## Commands

```bash
npm run dev                 # http://localhost:3000
npm run typecheck           # tsc --noEmit
npm run lint                # incl. architecture boundary rules
npm run build
npm run db:migrate          # applies pending migrations (live DB: review first)
npm run check:coexistence   # asserts the website is untouched
npm run verify:audit-chain
```
