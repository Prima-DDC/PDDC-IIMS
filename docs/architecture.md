# PDDC IIMS: System Architecture

**Status:** Milestone 0 (foundation). Satisfies the "system architecture"
pre-coding gate in PRD §20.3.
**Last updated:** 21 October 2026

Source of requirements: *PDDC Investigation Management & Intelligence Platform: Product Requirements Document (PRD) v1.0*, in the repository root.

---

## 1. Shape of the system

A **modular monolith** in Next.js 16 (App Router), organised by bounded context,
with dependencies pointing inward only (PRD §21.1).

```
Presentation      src/app/**        routes, composition only
                  src/features/**   per-feature UI, server actions, queries
Application       src/modules/*/application    use cases, ports, DTOs
Domain            src/modules/*/domain         entities, state machines, policies
Infrastructure    src/modules/*/infrastructure repositories and adapters
```

Bounded contexts: `iam`, `crm`, `casework`, `intel`, `evidence`, `docs`,
`reporting`, `audit`, `notify`, `config`, `ai`. Each exposes a single
`index.ts`; nothing reaches past it.

**These rules are enforced by eslint `no-restricted-imports`, not convention.**
A domain file importing React, Next, `postgres` or `@/lib/*` is a lint error and
a failed build. Verified working at M0 in both directions.

| Layer | Choice | Rationale |
| --- | --- | --- |
| Framework | Next.js 16.2.10, React 19.2.4, TypeScript strict | Matches prima-website-2.0 |
| Styling | Tailwind v4, CSS-first `@theme` | Matches prima-website-2.0; no config file |
| Server state | TanStack Query v5 | PRD §21.2 |
| UI state | Zustand v5: session, prefs, filters, wizard drafts only | PRD §21.2 |
| Forms | react-hook-form + zod 4, schemas shared with the API | PRD §21.2 |
| Database | Supabase Postgres 17.6, ten schemas | PRD §17.1 |
| Data access | `postgres.js` as the restricted `iims_app` role | See §3 |
| Identity | Supabase Auth, shared with primaddc.com | See §2 |
| Files | Supabase Storage, private buckets, TUS resumable | See §5 |
| Jobs | `pg_cron` + `pg_net` -> signed route handlers | See §6 |
| Email | Resend, via a transactional outbox | PRD §12 |

**Deliberate deviation from prima-website-2.0:** that app uses
`useActionState` + server actions with no client data library. The IIMS adds
TanStack Query, Zustand and react-hook-form because PRD §21.2 mandates that
split and this application is far more interactive (Kanban, relationship graph,
live dashboards, optimistic task updates, realtime invalidation).

---

## 2. Shared identity with primaddc.com: one login, two apps

The IIMS runs on the **same Supabase project as the live primaddc.com website**.
That is what gives every employee one set of credentials.

| Concern | Shared? |
| --- | --- |
| Identity (`auth.users`, password, TOTP enrolment) | **Yes**: one person, one login |
| Person record (`public.profiles`: name, email, photo) | **Yes**: read-only from the IIMS |
| Session cookie | **Yes**: scoped to `.primaddc.com` via `COOKIE_DOMAIN` |
| IIMS access | **No**: an administrator must provision an `iam.users` row |
| Authorization model | **No**: the IIMS has its own `iam.*` catalogue |

**Single sign-on** works because the website serves `primaddc.com` and the IIMS
serves `iims.primaddc.com`, and both set the Supabase session cookie with
`domain: ".primaddc.com"` (`src/lib/supabase/cookie-options.ts`). Signing in on
either app signs the employee into both: no second prompt, no duplicated MFA
challenge, no token-handoff endpoint. `COOKIE_DOMAIN` is empty on localhost,
where host-only cookies are correct.

> **Outstanding dependency.** prima-website-2.0 must pass the same
> `cookieOptions.domain`. Until it does, both apps still share one set of
> credentials, but an employee signs in separately on each.

**Access is deliberately not shared.** A primaddc.com account grants nothing
here: a signed-in employee with no `iam.users` row gets a clean "no IIMS
access" screen. The PRD's clearance model (§3.2) only means something if access
is explicit, and investigation content must stay need-to-know.

**Authorization is separate** because the website's role table cannot express
what the PRD requires: resource x action x scope x classification-ceiling
permissions, scoped and time-bounded role assignments, deny-overrides-allow,
role versioning with rollback, and two-person approvals.

### Isolation rules

| Rule | Why |
| --- | --- |
| Zero DDL on `public`, `auth`, `storage` | The website depends on them |
| Migrations tracked in `config._migrations` | `public._migrations` is the website's ledger |
| `iims_app` privileged only in IIMS schemas + 3 foreign `SELECT`s | A bug here cannot reach website data |
| New buckets only (`evidence`, `documents`) | No path or policy collisions |
| Realtime publication changes additive only | Dropping a table would break the website |

`npm run check:coexistence` asserts every one of these and exits non-zero on a
violation. `scripts/validate-migrations.mjs` applies pending migrations in a
transaction and always rolls back, so SQL can be proven before it touches
production.

**Baseline at M0:** Postgres 17.6; `public` has 22 tables; the website's ledger
is at `0019_ops_attachments.sql`.

---

## 3. Why data access bypasses supabase-js

PRD §13 requires that *the application database role hold no UPDATE or DELETE
privilege on the audit schema*. On Supabase:

- `service_role` has `BYPASSRLS`.
- `postgres` owns every table the migrations create, and a table owner bypasses
  its own policies.

Neither can deliver the guarantee. So all data access runs as a dedicated
**`iims_app`** role over a direct Postgres connection, and supabase-js is
restricted to auth, storage and realtime.

`withActor()` (`src/lib/db/client.ts`) opens one transaction per unit of work
and publishes the actor as transaction-local settings:

```sql
select set_config('iims.user_id', $1, true),
       set_config('iims.clearance', $2, true),
       set_config('iims.request_id', $3, true),
       set_config('iims.aal', $4, true);
```

`is_local = true` scopes them to the transaction, so nothing leaks to the next
borrower of a pooled connection. Policies read
`nullif(current_setting('iims.user_id', true), '')::uuid` and therefore **fail
closed** if a query ever escapes the wrapper.

Connection notes, each a real trap:

- **Transaction-mode pooler (6543) at runtime, session mode (5432) for
  migrations.** Transaction mode forbids prepared statements, so `postgres.js`
  sets `prepare: false`; without it, queries fail intermittently under load.
- **`FORCE ROW LEVEL SECURITY` on every table**, not just `ENABLE`.
- **Grants are allow-listed, pinned with `ALTER DEFAULT PRIVILEGES FOR ROLE
  postgres IN SCHEMA <x>`**, because `GRANT ... ON ALL TABLES` covers only tables
  that exist at that moment.
- **TRUNCATE is never granted** anywhere: it is a separate privilege that
  row-level triggers cannot intercept.
- **The IIMS schemas are not exposed to the Data API**, so PostgREST cannot
  reach `audit` or `evidence` at all.
- **TLS is pinned** to the Supabase Root 2021 CA
  (`src/lib/db/supabase-ca.ts`, sha256 `80:70:25:AD:...`). Supabase signs its
  Postgres certificates with its own CA, so an unpinned connection fails with
  `SELF_SIGNED_CERT_IN_CHAIN`. Pinning is the fix; disabling verification is
  never acceptable for evidence-bearing traffic.

---

## 4. Audit trail: what we guarantee, and what we do not

`audit.audit_log` is hash-chained and protected by four independent locks:

1. **Privilege**: `iims_app` holds `INSERT` only; no UPDATE, DELETE, TRUNCATE.
2. **RLS**: `ENABLE` + `FORCE`, one `FOR INSERT` policy, nothing else.
3. **Row trigger**: `BEFORE UPDATE OR DELETE` raises.
4. **Statement trigger**: a separate `BEFORE TRUNCATE`, because row triggers
   never fire for `TRUNCATE`.

`RULE`-based protection was rejected: `DO INSTEAD NOTHING` discards the
statement *silently*, so the caller believes it succeeded.

**The chain.** `row_hash = sha256(prev_hash || canonical_row_json)`, computed in
a `BEFORE INSERT` trigger. It cannot be a generated column, because a generated
expression may only reference its own row. The trigger is `SECURITY DEFINER`
with `search_path = ''` so it can read the chain tail that `iims_app` cannot
`SELECT`, and it **serializes on `audit.chain_head ... FOR UPDATE`**. Without
that lock two concurrent inserts read the same tail and fork the chain: silently, and only under load. The payload is hashed from an explicit,
fixed-order column list, never `to_jsonb(new)`, so adding a column later cannot
invalidate verification of historical rows.

`audit.verify_chain()` recomputes the chain and reports the first divergence.
Reads go through `audit.read_audit_log()`, which records the read in
`audit.access_log`: viewing the audit log is itself audited (PRD §13).

### Residual risk: accepted limitation

PRD §13 and §3.5 say the audit log is append-only for *everyone*. **On hosted
Supabase that is not achievable, and the PRD's wording needs amending.**

The `postgres` role owns these tables and can `DROP TRIGGER`, `ALTER TABLE ...
NO FORCE ROW LEVEL SECURITY`, `DROP POLICY`, or set
`session_replication_role = 'replica'` to skip triggers entirely. Supabase's
only superuser (`supabase_admin`) is not available to customers, and
privileged-role event triggers are skipped for reserved roles, so no lock holds.

**What the platform delivers instead, for PDDC to accept in writing:**

> Append-only and tamper-**proof** for every application role; tamper-**evident**
> against the platform administrator role, via hash chaining plus signed
> chain-head anchors published on a schedule to storage outside this project.

Mitigations: the `postgres` credential is used only by the migration runner and
held as a break-glass secret; and `audit.chain_anchors` + off-system export make
tampering **detectable** even though it cannot be prevented. External anchoring
is the only genuine defence here, which is why it is not optional.

An earlier draft added an `iims_audit_owner` role to own the audit schema. It
was dropped: Postgres 16 split role membership into SET/INHERIT/ADMIN, the
implicit creator grant carries `SET FALSE`, and working around that would
require every future migration to `SET ROLE` before touching an audit object.
It raised no real barrier against `postgres` anyway. Recorded in full in
`supabase/migrations/0002_app_role_and_grants.sql`.

---

## 5. Conflict screening: finding matches without concluding anything

PRD 8.3 is unusually specific, and the specificity is the requirement: the
system "searches all PDDC records for potential matches" and "never concludes
they are the same". It has to catch two named examples:

| Searched for | On file | What makes it hard |
| --- | --- | --- |
| John K. Mensah | John Mensah | an inserted middle initial |
| ABC Holdings Ghana Limited | ABC Holdings Ltd | a different suffix and an extra country word |

### How the matching works

Three signals, combined with OR, because each catches something the others
miss:

1. **Trigram similarity** on a normalised form of the name.
   `crm.normalise_name` lower-cases, folds accents, replaces punctuation with
   spaces, removes company suffixes and filler words as whole words, and
   collapses whitespace. It is `IMMUTABLE`, which is what lets the result be
   indexed with a GIN trigram index, and that is what makes screening fast
   enough to run interactively. "ABC Holdings Ltd" and "ABC Holdings Limited"
   normalise to the identical string; "ABC Holdings Ghana Limited" normalises
   to one token more, which is what the score is for.
2. **A phonetic key**, `dmetaphone` per word joined in order, so names that
   sound alike but are spelled differently are caught: Smyth against Smith.
3. **Substring containment** in either direction, which is what catches the
   country-word case cleanly and gives the reviewer a reason in words rather
   than only a number.

`extensions.similarity(a, b) >= 0.3` is used rather than the `%` operator.
Two reasons: `%` is unresolvable under the empty `search_path` every function
here pins, and it reads its threshold from a session GUC, so the same query
could behave differently in two sessions. An explicit comparison is
deterministic and the threshold is a parameter PDDC can tune.

### The part that is a product decision, not a technical one

`crm.find_conflicts` returns `searched_term`, `matched_table`, `matched_id`,
`matched_label`, `similarity`, `phonetic_match` and `match_reason`. There is
deliberately **no column that asserts sameness**, and no threshold above which
the function decides anything. Nothing is merged, and running a screening
cannot change a record: the function is `STABLE` and writes nothing.

What the interface says is therefore part of the guarantee rather than
decoration. The match list is headed by a sentence generated from the results
by `matchSummary`, so the wording cannot drift into claiming a conclusion, and
each row shows the score with the reason it was returned.

### The decision, and why it is immutable

An authorised manager records one of three outcomes: cleared, further review
required, or conflict declined. Once recorded it cannot be changed, and three
independent things enforce that:

- the use case checks first, so the message is readable rather than a
  constraint name;
- a `BEFORE UPDATE` trigger on `crm.conflict_checks` raises if the decision,
  its reason, its author or its timestamp would change;
- no route exists that could edit a decided check.

A mistaken decision is corrected by raising a new check, exactly as a mistaken
audit entry is corrected by a new entry. The reason is the record relied upon
later, when somebody asks why PDDC took work that resembled a conflict, so it
has a minimum length and is stored verbatim alongside the terms that were
searched.

**Why "further review required" is allowed through the approval gate.** It
reads like a blocker, but PRD 8.3 makes it a decision in its own right: it
records that a conflict exists and has been considered. What the gate has to
refuse is *silence*, which is why an absent check and an undecided check are
both refused while this one is not.

---

## 6. Evidence upload and hashing

The obvious design: proxy the upload through a route handler and hash it
server-side: **cannot work**, and this was corrected before any code was
written:

- **Vercel caps function request bodies at 4.5 MB**, with no configuration
  flag. Its own guidance is to bypass the function with direct-to-storage
  uploads.
- **Supabase Storage exposes no SHA-256 hook.** The stored `eTag` is not a
  whole-file digest for multipart/TUS uploads, and the S3 checksum and
  `Content-MD5` headers are unsupported.

So hashing is a two-step, explicitly modelled process:

1. **Client declares**: the browser streams the file through WebCrypto for a
   SHA-256, uploads direct to Storage via TUS (6 MB chunks exactly, as Supabase
   requires; URL valid 24 h), and the evidence row is registered with
   `declared_sha256` and state **`hash_unverified`**.
2. **Server verifies**: an `AFTER INSERT` trigger on `storage.objects` ->
   `pg_net` -> an Edge Function **streams** the object back, recomputes the hash,
   and moves the row to **`verified`** or **`mismatch`**. Both hashes go into
   the hash-chained audit row, so a mismatch is permanently recorded.

`hash_unverified -> verified | mismatch` is a first-class state in the evidence
domain model and is surfaced on the `IntegritySeal` badge. An investigator can
always tell a server-attested hash from a client-asserted one.

Originals live in an **INSERT-only** bucket with no UPDATE/DELETE policy, so
they are genuinely write-once; without `x-upsert`, re-uploading a path returns
`400 Asset Already Exists`, which is the idempotency PRD §21.7 asks for.

For the runbook: Storage has **no object versioning or object lock**, deletes
are permanent, and **objects are not included in database backups**: evidence
files need their own backup job.

---

## 7. Identity, lockout and background work

Supabase Auth provides TOTP MFA with AAL2, which is what the PRD requires.
Passkeys exist but are beta and first-factor only, so **TOTP remains the AAL2
mechanism**. Three gaps are filled on our side:

- **`ban_duration` does not revoke live sessions**, and access tokens are
  stateless JWTs. PRD §3.3 requires suspension to be immediate, so every
  authenticated request: inside the transaction that already sets the GUCs: also checks `iam.users.status = 'active'` and that the JWT's `session_id` is
  still in `auth.sessions`.
- **There is no account lockout**; Supabase rate-limits per IP, not per account.
  The failed-attempt counter and threshold live in `iam` (PRD §14).
- **Session time-boxing is Pro-only**, so the configurable session timeout is
  enforced by our own liveness check.

`iam.users.id` references `auth.users(id)`. We cannot create objects inside the
`auth` schema (`CREATE ON SCHEMA auth` is revoked from `postgres`), so there are
no triggers or views there: `iims_app` simply holds `SELECT`.

Supabase's built-in email sender is capped at 2/hour project-wide, so **Resend
is configured as the custom SMTP provider** as well as the outbox transport: one
sender identity, SPF/DKIM/DMARC configured once.

**Background jobs** use `pg_cron` + `pg_net`. A cron job runs as the role that
scheduled it (`postgres`), which would mean owner-bypass of RLS, so **every job
body does nothing but `net.http_post`** to a signed route handler that connects
back as `iims_app`. The shared secret lives in Supabase Vault;
`vault.decrypted_secrets` is denied to `iims_app`. `cron.job_run_details` is
never auto-pruned, so a cleanup job ships with the first cron migration.

The free-tier inactivity pause is **not** a risk here, precisely because the
project also serves the live website: it never goes idle.

---

## 8. Platform limits and the plan recommendation

| Free-tier limit | Consequence |
| --- | --- |
| 500 MB database, shared with the website | Fine for build, demo and UAT |
| 1 GB storage, **50 MB max object** | The binding constraint: video and disk images will not fit |
| 5 GB egress, 200 realtime connections, 500K edge invocations/mo | Comfortable (minute-level cron ~ 43K/mo) |
| No PITR, no session time-boxing, no log drains | PRD §14 and §21.3 need Pro |

**Recommendation:** build and demo on Free, move to **Pro (~$25/mo) before any
pilot with real case data**. Pro is what buys point-in-time recovery, the
500 GB object limit and a project that never pauses: all three explicitly
required by the PRD. This is a platform cost, not an AI cost.

---

## 9. AI (cloud free tiers only)

AI is **assistive only and not a V1 dependency** (PRD §22, Amendment 12): the
platform works fully with it switched off.

No free hosted tier is unlimited. Verified October 2026: Groq ~30 req/min and
200K tokens/day; Cerebras ~1M tokens/day at 5 req/min; OpenRouter `:free`
20 req/min and 50 req/day (1,000 only after $10 lifetime credit); Cloudflare
Workers AI ~10K neurons/day. The gateway therefore cascades
**Groq -> Cerebras -> OpenRouter -> Cloudflare** with circuit breakers, a job
queue with per-user and per-case quotas, and a response cache: and degrades to
"unavailable" plainly when the allowance is exhausted.

Guardrails are enforced server-side in the gateway, never in a prompt: AI off
by default per case; a classification gate that blocks anything above INTERNAL,
plus human-source identities, evidence files and client financials; reversible
redaction whose mapping never leaves the platform; grounded-only retrieval that
cites finding/information/evidence IDs; outputs labelled as suggestions and
never auto-saved; and every request logged with provider, model, case, user,
classification and token count.

If PDDC later wants genuinely unlimited AI, the same gateway points at a
self-hosted model with no application changes (PRD §22.4, "local-model path").

---

## 10. Open questions carried as assumptions

From PRD §24, plus two raised by platform verification. Build defaults are
recorded here so they are easy to change.

1. **Countries/offices, data residency**: `country`/`office` tags on all
   records from day one; single-region hosting until told otherwise.
2. **RPO 15 min / RTO 4 h**: assumed. Needs Pro (PITR) *and* a separate
   object-backup job, since Storage is not in database backups.
3. **Hosting**: Supabase hosted, every dependency behind a port.
4. **AI providers and permitted content**: public-source and PUBLIC/INTERNAL
   only, enforced by the gateway. The allow-list ships empty, so AI is inert
   until an administrator opts in.
5. **Report delivery**: secure signed link, with encrypted-attachment export
   also available.
6. **Largest evidence file PDDC must store?** 50 MB is the free-tier ceiling.
7. **When to move to Pro?** Recommended before any real case data.
