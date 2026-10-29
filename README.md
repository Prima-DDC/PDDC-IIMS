# PDDC IIMS

The Intelligence & Investigation Management System for Prima Due Diligence
Consult: one secure record of every due diligence, corporate investigation and
intelligence matter, from first enquiry to archived final report.

Built to the PRD in this repository. Start with
[docs/architecture.md](docs/architecture.md) for how it fits together, and
[docs/PROGRESS.md](docs/PROGRESS.md) for what is built and verified so far.

---

## The one thing to know first

**This project shares a Supabase database with the live primaddc.com website.**

That is deliberate: one `auth.users` row per person means every employee has a
single set of login credentials across both systems. It also means every
migration runs against production, so:

- The IIMS owns ten schemas (`iam crm casework intel evidence docs reporting
  audit notify config`) and **runs no DDL against `public`, `auth` or
  `storage`**, which the website depends on.
- Migrations are tracked in `config._migrations`, never `public._migrations`.
- The runtime role `iims_app` holds privileges **only** inside those ten
  schemas.
- `npm run check:coexistence` asserts all of the above and fails the build on a
  violation.

Validate before you apply:

```bash
node --env-file=.env.local scripts/validate-migrations.mjs   # applies, then always rolls back
```

---

## Getting started

```bash
npm install
cp .env.example .env.local        # fill in the Supabase values

npm run db:migrate                # apply pending migrations
node --env-file=.env.local scripts/bootstrap-app-role.mjs   # give iims_app its credential
npm run check:coexistence         # prove the website is untouched

npm run create-admin -- you@primaddc.com "Your Name"
npm run dev                       # http://localhost:3000
```

The first administrator signs in with their existing PDDC staff credentials if
they already have an account, or through an emailed invitation if not. Either
way they enrol an authenticator on first sign-in, because two-factor
authentication is mandatory.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint, including the architecture boundary rules |
| `npm test` | Domain unit tests and live-database integration tests |
| `npm run test:e2e` | Playwright, against a real browser and the real project |
| `npm run db:migrate` | Apply pending migrations |
| `npm run check:coexistence` | Assert the website is untouched and the audit trail is append-only |
| `npm run docs:schema` | Regenerate `docs/erd.md` and `docs/permission-matrix.md` from the live database |
| `npm run verify:audit-chain` | Recompute the audit hash chain, check the head agrees with it, and compare it against the most recent anchor. `-- --anchor` records a new one |
| `npm run seed:e2e` | Create or clean the end-to-end fixtures (needs `E2E_ALLOW_SEED=1`) |

---

## How it is put together

A **modular monolith** in Next.js 16, organised by bounded context, with
dependencies pointing inward only:

```
src/app/**          routes, composition only
src/features/**     per-feature UI, server actions, queries
src/modules/*/
  domain/           entities, state machines, policies: pure TypeScript
  application/      use cases and ports
  infrastructure/   repositories and adapters
  index.ts          the server-side public surface
  shared.ts         the client-safe half: types, constants, pure rules
src/lib/**          database client, Supabase clients, session
```

`IIMS_DB_DEBUG=1` prints one line per SQL statement, shape only and never
parameter values. It is the quickest way to see why a page is slow: every
statement is a network round trip to the database's region, a page render costs
around 18 of them and a mutation with its revalidation around 27, so latency
shows up as round-trip count rather than as slow queries.

**The boundaries are enforced by eslint, not convention.** A domain file
importing React, Next, `postgres` or `@/lib/*` is a lint error and a failed
build, and so is a feature importing a module's internals. Client components
import `@/modules/<name>/shared`; server code imports `@/modules/<name>`.

### Three decisions worth understanding

**Data access does not use supabase-js.** PRD 13 requires the application
database role to hold no UPDATE or DELETE on the audit schema. Supabase's
`service_role` has `BYPASSRLS` and `postgres` bypasses RLS by owning the
tables, so neither can deliver that. All data access runs as a restricted
`iims_app` role over a direct Postgres connection, through `withActor()`, which
publishes the caller's identity as transaction-local settings for RLS and the
audit triggers to read. supabase-js is used only for auth, storage and
realtime.

**The audit trail is hash-chained and append-only**, protected by four
independent locks: INSERT-only privileges, `ENABLE` plus `FORCE` row-level
security, a row trigger rejecting UPDATE and DELETE, and a separate statement
trigger for TRUNCATE. Reads go through a SECURITY DEFINER function that checks
the audit permission and records the read. See the honest limitation in
[docs/architecture.md](docs/architecture.md) section 4: it is tamper-proof for
every application role and tamper-evident against the platform administrator.

**Evidence hashing is two-step.** Vercel caps function request bodies at
4.5 MB and Supabase Storage exposes no SHA-256 hook, so the browser declares a
hash computed with WebCrypto, and a worker then streams the object back and
verifies it server-side. `hash_unverified | verified | mismatch` is a
first-class state in the evidence model, shown on the integrity badge, so an
investigator can always tell a server-attested hash from a client-asserted one.

---

## Conventions

Read [AGENTS.md](AGENTS.md) before making changes. The short version:

- **Next 16 differs from older documentation.** Read the relevant guide in
  `node_modules/next/dist/docs/` first. `middleware.ts` is now `proxy.ts`, and
  React 19 treats `setState` inside an effect as an error.
- Tailwind v4, CSS-first. Every token lives in `src/styles/globals.css` under
  `@theme`; there is no `tailwind.config`. Use `bg-surface`, `text-muted`,
  `text-risk-high`, never a raw hex value.
- Motion is pure CSS keyframes declared as `--animate-*` tokens, and everything
  collapses under `prefers-reduced-motion`.
- Every table gets `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, and policies
  fail closed.
- `localStorage` holds UI preferences only. Never tokens, evidence, subject
  names, findings or report text.
- No em-dashes anywhere in the source, comments or documents.

---

## Known limitations

Carried deliberately, and all recorded in
[docs/PROGRESS.md](docs/PROGRESS.md):

- Audit append-only is not absolute against the `postgres` role. Needs a PRD
  amendment and written acceptance.
- `pg_cron` and `pg_net` are not yet enabled, so the notification outbox,
  overdue scans and scheduled integrity checks are not running.
- Single sign-on needs prima-website-2.0 to scope its session cookie to the
  same parent domain. Until then employees share one set of credentials but
  sign in twice.
- The Supabase free tier caps a stored object at 50 MB and has no
  point-in-time recovery. Pro is recommended before any pilot with real case
  data.
