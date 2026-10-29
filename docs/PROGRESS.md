# PDDC IIMS build progress

Running record of what is built, verified and still outstanding. Updated as
each vertical slice lands.

**Verification commands** (all must pass before a slice is called done):

```bash
npx tsc --noEmit                 # types
npm run lint                     # incl. architecture boundary rules
npm run build                    # production build
npm test                         # domain unit + live database integration
npm run test:e2e                 # real browser, real Supabase project
node --env-file=.env.local scripts/validate-migrations.mjs   # dry run, always rolls back
node --env-file=.env.local scripts/check-coexistence.mjs     # website untouched
```

---

## Status summary

| Milestone | Scope | State |
| --- | --- | --- |
| M0 | Foundation, design system, coexistence tooling | Done, verified |
| M1 | IAM, audit chain, authentication, admin CRUD | Done, verified |
| M1 | CSV bulk import, two-person approval loop | Done, verified |
| M2 | CRM, intake, conflict screening, engagements | Done, verified |
| M3 | Casework core (end of PRD Phase 1A) | Done, verified |
| M4 | Documents, evidence and chain of custody | Done, verified |
| M5 | Intelligence: entities, sources, information, findings | Done, verified |
| M6 | Reporting, QA, closure, archive, management reports | Done, verified |
| M7 | Notifications, dashboards, AI gateway | Not started |
| M8 | Hardening and the PRD 20.1 acceptance demo | Not started |

Sections not yet built render an honest placeholder naming their milestone and
what they will contain, rather than a dead link or a screen of invented data.
The permission gate for each is already in place.

---

## Verified facts about the live environment

Established by direct inspection, not assumption:

- Postgres **17.6** on the shared Supabase project `iccbchzopnomagcqbhqe`.
- The website (`primaddc.com`) owns `public`: **22 tables**, ledger at
  `0019_ops_attachments.sql`. Untouched by every IIMS migration.
- `postgres` has `rolbypassrls = true`, which is exactly why runtime data
  access uses `iims_app` instead.
- `service_role` has `rolbypassrls = true`. Never used for data access.
- Supabase signs Postgres certificates with its own **Supabase Root 2021 CA**
  (sha256 `80:70:25:AD:...`, expires 2031-04-26), pinned in
  `src/lib/db/supabase-ca.ts`. Unpinned connections fail with
  `SELF_SIGNED_CERT_IN_CHAIN`.
- `iims_app` was granted SELECT on `auth.users` and `auth.sessions` in 0002,
  but that was **ineffective**: it has no USAGE on the `auth` schema. The
  website's RLS on `public.profiles` also keys on `auth.uid()`, which is null
  on a direct connection, so it saw zero rows. Both are now reached through
  narrow SECURITY DEFINER functions instead (migration 0010), and the dead
  grants were revoked.
- **No admin session API exists** in supabase-js v2: `auth.admin.signOut()`
  needs the user's own JWT, and `listUserSessions`/`deleteSession` do not
  exist. Session revocation is done in the database (migration 0011).
- `auth.mfa_factors.secret` is plaintext base32, which the end-to-end seed
  uses to create deterministic authenticators.
- `postgres` **can** write to `auth.users`, so test fixtures live in a
  rolled-back transaction and leave zero residue.
- `cron` and `net` schemas are **not yet present**: `pg_cron` and `pg_net`
  must be enabled before the outbox worker (M7).
- Local toolchain: Node 24.14.0, npm 11.9.0. No Docker, psql or Supabase CLI,
  which is why migrations run through `scripts/db-migrate.mjs`.

---

## M0: foundation

Design system in `src/styles/globals.css`: Tailwind v4 CSS-first, semantic
tokens indirected through `--p-*` palette variables so one `data-theme`
attribute flips the whole app. Risk scale and five-step classification scale,
both AA in light and dark. Motion is pure CSS `--animate-*` tokens, all
collapsing under `prefers-reduced-motion`.

Signature components: `BottomNavBar` (sliding pill, More sheet, safe-area
insets, role-aware, required below `md`), `GlassTopBar` (liquid glass, morphs
on scroll), `Preloader`, `AnimatedBackground`, `ClassificationBanner`,
`CaseStatusTimeline`, `TraceabilityStrip`, `CustodyLedger`, `IntegritySeal`,
`ThemeToggle`.

Architecture boundaries enforced by eslint `no-restricted-imports` and
**probed with deliberate violations**: a domain file importing `postgres` or
`@/lib/*` fails, and a feature file importing `@/modules/*/domain/*` fails.
Client components import `@/modules/iam/shared`, the barrel with no
`server-only` marker, so postgres never reaches the browser bundle.

## M1: identity, authorization, audit and administration

Migrations `0001` to `0012`, all applied.

| Migration | Contents |
| --- | --- |
| 0001 | Ten schemas, extensions, immutable unaccent wrapper, `config._migrations` |
| 0002 | `iims_app` role, per-schema grants, default privileges |
| 0003 | Hash-chained append-only audit with four independent locks |
| 0004 | Audit sequence grants (bug found by the test suite) |
| 0005 | Organisation units, `iam.users`, login attempts, invitations |
| 0006 | Roles, permissions, features, user roles, overrides, two-person requests |
| 0007 | Authorization functions and RLS policies |
| 0008 | `audit.write`, `audit.record_access`, permission-checked `read_audit_log` |
| 0009 | Starter catalogue: 17 roles, 12 features, full PRD 16 permission matrix |
| 0010 | Shared-directory bridge and per-request actor resolution |
| 0011 | Real session revocation, single-session revoke, MFA enrolment sync |
| 0012 | Sign-in support: lockout state and attempt recording by email |
| 0013 | Permission-checked action list for the audit filter |
| 0014 | `iam.profile_basics`, the shared-directory read |
| 0015 | `audit.write` without RETURNING |
| 0016 | Extension access for the application role |
| 0017 | Audit rows record the actor's email, not just their id |

### Application surface

- **Authentication**: sign-in with per-account lockout, mandatory TOTP with
  in-browser enrolment, no-access and suspension screens, sign out of one or
  all devices.
- **Shared single sign-on**: one `auth.users` identity with primaddc.com, and
  the session cookie scoped to `COOKIE_DOMAIN` so a session on either app is
  visible to the other.
- **Users**: list with search, status, role, office and department filters and
  cursor pagination; provision from the shared staff directory; invite by
  email; edit with optimistic concurrency; assign, scope, time-bound and
  remove roles; set the primary role; per-user permission overrides with
  mandatory reason and optional expiry; per-user feature overrides; status
  transitions through a state machine; recoverable removal and restore;
  password reset, session revocation, MFA reset and unlock; active sessions
  and sign-in history; the effective-permissions viewer naming the source of
  every entry.
- **Roles**: create, clone with permissions and features, edit, activate and
  deactivate, delete with the in-use and baseline guards; the permission
  builder over resource, action, scope and classification ceiling; a permission
  catalogue that can be extended; role features; version history with
  rollback; separation-of-duties pairs.
- **Organisation**: countries with data-residency notes, offices and
  departments, each with full create, edit, activate and delete.
- **Features**: definitions with create, edit and delete.
- **Approvals**: the two-person queue, where the requester can never approve.
- **Recycle bin**: soft-deleted records with restore.
- **Audit trail**: filterable by action and date, with the hash chain
  recomputed and reported on load.

### What the tests prove

**Domain unit tests (35)**, no database or framework:
classification ordering and the AI egress ceiling; which changes need a second
approver; self-escalation detection; no approving your own work; separation of
duties in either order; the user status machine including the one-way move to
archived; baseline and in-use role protection; deny-overrides-allow including
across differing scopes; and the twelve explanation cases behind the
"why can or cannot this user do X" viewer.

**`app-role-containment.test.ts` (15)**, connected **as `iims_app` over the
real pooler**, proving the keystone claim:
connects as `iims_app` with no `BYPASSRLS`; can append to the audit log but
**cannot** SELECT, UPDATE, DELETE or TRUNCATE it; cannot read the trail without
the audit permission; can read `public.profiles` but **cannot write it**;
cannot read the website's `content_blocks`, `public._migrations` or Vault; and
transaction-local actor settings do not leak to the next pooled borrower.

**`authorization.test.ts` (45)**, against the live database in rolled-back
transactions: role union and user grants; deny overriding an allow at a
different scope; expired and future-dated assignments ignored; clearance
capping the ceiling and the ceiling capping clearance; the Administrator
wildcard covering a resource **invented after** the role existed; suspended,
deactivated, invited and locked-out users holding **nothing**;
`permissions_version` bumping so a change applies without re-login; the last
administrator being un-suspendable and un-deletable; self-approval rejected by
a table constraint; lockout after five failures and cleared on success;
feature flags in all three states; the chain unbroken over 25 sequential
appends; `UPDATE` rejected **even for the table owner**; and tampering
**detected** once the guard trigger is removed.

**`user-repository.test.ts` (15)**: provisioning adds the baseline role
automatically; duplicate provisioning is refused; the audit row is written in
the same transaction and carries the caller IP and device; optimistic
concurrency rejects a stale edit; removal is a soft delete and restore brings
the record back deactivated; roles assign and remove with exactly one primary;
effective permissions carry their source; overrides take effect and are
removable; feature overrides work in both directions; filters and the recycle
bin behave; and statistics, directory and login history read correctly.

**End-to-end in a real browser (`auth.spec.ts`, 12)**: unauthenticated
redirect with the destination preserved; the sign-in page not indexable;
identical wording for a wrong password and an unknown account, so the form
cannot enumerate accounts; client-side validation without a round trip;
**two-factor authentication proved mandatory**; a full sign-in completing TOTP
enrolment and reaching the dashboard; sign-out protecting the dashboard again;
a staff account with no IIMS record refused with an explanation; a suspended
account refused; and five failed attempts locking the account, with a correct
password afterwards still refused.

The TOTP implementation used by the tests is verified against all five
RFC 6238 vectors.

---

## M2: clients, intake, conflict screening and engagements

Delivers PRD section 8 and the intake pipeline of section 4.1. The chain the
rest of the platform hangs off is now real: **Client to Engagement to Case**,
with cases arriving in M3.

### Database

Three migrations, applied to the live shared project and verified by
`npm run check:coexistence` (zero DDL outside the IIMS schemas):

- **0018** `config.id_sequences` and `config.next_human_id`, which allocate
  `CLI-YYYY-NNNNNN`, `ENG-...`, `ENQ-...` and `CFL-...` from a per-year
  sequence inside the caller's transaction, so a retry can neither skip nor
  duplicate a number (PRD 21.7). Then `crm.clients`, `client_contacts`,
  `client_documents`, `enquiries`, `kyc_records` and `engagements`.
  `crm.enquiries` deliberately has **no** `deleted_at`: intake history is
  retained permanently (PRD 4.1), so a declined enquiry stays readable with
  the reason it was declined.
- **0019** conflict screening. `crm.normalise_name` lower-cases, folds
  accents, strips punctuation and removes company suffixes and filler words,
  and is IMMUTABLE so the result can be indexed; `crm.phonetic_key` applies
  dmetaphone per word. Matching combines trigram similarity with the phonetic
  key and substring containment. Two triggers make the outcome dependable:
  a decided check cannot be changed, and a recorded match cannot be altered.
- **0020** row-level security for the schema, plus the permission atoms the
  PRD 16 matrix refers to. Finance holds `clients:view` and
  `engagements:view` so it can bill, and nothing on cases, evidence or
  findings, so it cannot read investigative content at all.

### The three rules that are the product

Everything else in M2 is bookkeeping around these:

1. **KYC is derived, never typed in.** `assessKyc` works the position out from
   the records on file: identity, registration and ownership for every client,
   plus sanctions and PEP screening for a high or critical risk one. A failed
   required check fails the whole client; an expired one expires it. The
   `kyc_status` column is a cache of that answer, rewritten whenever a record
   changes or the risk rating moves, and the screen has no field for it.
2. **Screening finds potential matches and stops there.** `crm.find_conflicts`
   returns candidates with a score and the reason each was returned. There is
   no column that asserts sameness, nothing is merged, and no threshold causes
   the system to decide anything. The interface says so in as many words,
   because PRD 8.3 makes that wording a requirement rather than decoration.
3. **A conflict decision is recorded once.** Three independent things enforce
   it: the use case checks first so the message is readable, a database trigger
   refuses the UPDATE, and no route exists that could edit a decided check. A
   mistaken decision is corrected by raising a new check, exactly as a mistaken
   audit entry is corrected by a new entry.

### The approval gate

An engagement cannot be approved unless all three hold, and none is a matter
of permission:

- a conflict check has been run **and decided**, because an undecided check is
  not a clearance and neither is no check at all;
- the decision was not "declined";
- the approver is not the person who raised it.

"Further review required" passes, deliberately: PRD 8.3 makes it a decision in
its own right, recording that a conflict exists and has been considered. What
it must not be is silence. Once approved, the scope of services and the
commercial terms are frozen, because they are what was signed off; changing
them is a scope change, which is its own controlled process in M3.

### Application surface

- `src/modules/crm/` with the usual four layers. The domain layer holds the
  enquiry and engagement state machines, the KYC assessment, the conflict
  rules and the removal rules, and imports nothing but the classification leaf.
- `src/features/clients`, `src/features/intake`, `src/features/engagements`.
- Nine routes: `/clients`, `/clients/new`, `/clients/[id]`, `/intake`,
  `/intake/new`, `/intake/[id]`, `/intake/conflicts`,
  `/intake/conflicts/new`, `/intake/conflicts/[id]`, `/engagements`,
  `/engagements/new`, `/engagements/[id]`.
- Full CRUD on every CRM record, with soft delete, restore, optimistic
  concurrency on each mutable table, and an audit row written in the same
  transaction as the change.

### Shared code pulled out during M2

Four things were about to be copied for the third or fourth time, so they
moved rather than multiplying. This is a reduction in total lines, not an
addition:

- `src/lib/forms.ts`: the form-state shape every server action returns, plus
  the zod field helpers. It had lived inside the user administration feature
  and was already imported by three others, which was the signal.
- `src/components/ActionForm.tsx`, moved out of that feature for the same
  reason.
- `src/components/UrlFilters.tsx`: the search box and dropdowns that keep
  their state in the URL. The user list now uses it too, with its labels
  unchanged so its tests still apply.
- `Pagination`, `TableSkeleton`, `FiltersSkeleton` and `StatTile` in
  `src/components/ui.tsx`.

### What the M2 tests prove

- **56 domain tests** over the state machines, the KYC rule, the approval
  gate, the decision rules and the removal rules. No database.
- **25 screening tests** against the real Postgres, including both examples
  PRD 8.3 names by hand: *John Mensah / John K. Mensah* and *ABC Holdings Ltd
  / ABC Holdings Ghana Limited* are each flagged as potential matches, in both
  directions, and never merged. Also that a decided check cannot be changed,
  that a recorded match cannot be altered, and that screening without the
  permission is refused.
- **19 repository tests** against the real Postgres: identifier allocation,
  the derived KYC status being stored, an approval recorded under its own
  audit action, the frozen scope, a stale update rejected, a subject's own
  checks being filtered in the query, and the gate reading the decided check.
- **4 containment tests** on the CRM policies as the application role actually
  sees them, in `app-role-containment.test.ts`. They belong there rather than
  with the repository tests, because those connect as `postgres`, which owns
  these tables and therefore bypasses their policies.
- **6 permission and wording tests** through the browser: an investigator can
  read clients but not create one and cannot reach screening at all, and the
  screening screen says what it does not do and asks for a subject when it was
  not given one.
- **One end-to-end journey** through the browser, from creating the client to
  an approved engagement, including a second identity for the approval,
  because self-approval is refused and proving approval works therefore takes
  two people. The journey is one test with steps rather than many tests: every
  stage depends on the one before it.

---

## M3: casework, tasks, safety and the case commercials

The end of PRD Phase 1A. The case record itself, the work done on it, the
activity log, the investigation plan, investigator safety and the small set of
numbers PRD 5.6 asks for.

### Database

Migrations 0022 to 0033. The casework schema now holds 18 tables: `cases`,
`case_assignments`, `case_objectives`, `risk_assessments`, `scope_versions`,
`scope_change_requests`, `case_communications`, `investigation_plans`,
`plan_versions`, `tasks`, `task_comments`, `activities`, `safety_plans`,
`check_ins`, `incidents`, `case_financials`, `time_entries` and `expenses`,
plus the stage history.

Three attitudes to change, and the differences are the design:

- **Live records** are edited with optimistic concurrency: cases, tasks,
  safety plans, incidents, financials, time entries and expense claims.
- **Append-only records** refuse UPDATE and DELETE at the privilege, the
  policy and the trigger: `activities` (PRD 9.4) and `check_ins`. A mistake in
  the activity log is corrected by a new entry pointing at the original; a
  check-in is corrected by recording another.
- **Versioned records** freeze on approval and change by producing the next
  version: `scope_versions` and `plan_versions`.

The configured lifecycle (PRD 4.3) stays data: 14 stages and their permitted
transitions live in `config.workflow_definitions/stages/transitions`, seeded
by 0023, and the progress rail and the stage dropdown are both built from it.
`/admin/workflows` is where an administrator changes it, which is what makes
"without code changes" true rather than "without code changes, by writing
SQL". The screen shows the consequences before the change: how many live
cases sit in each stage, which stages nothing leads to, and which stages have
no way out. It refuses to take away the only route out of a stage that holds
cases, and says how many are there. A stage is never deleted, because cases
and audit entries point at it: it is retired by taking away the routes into
it.

### Application surface

| Screen | What it does |
| --- | --- |
| `/cases`, `/cases/[id]`, `/cases/new` | The case register and the case file, tabbed per PRD 18 screen 9: Summary, Plan, Tasks, Activity, Communications, Safety, Finance |
| `/tasks`, `/tasks/[id]` | The cross-case task register in list, board and calendar views (PRD 9.2), and one task with its sub-tasks and comments |
| Case file, Plan tab | The investigation plan with its versions, its submission and its review |
| Case file, Tasks tab | The case's tasks in list, board and calendar views |
| Case file, Activity tab | The append-only log and its corrections |
| Case file, Safety tab | The safety plan, who is out, overdue check-ins, and incident reports |
| Case file, Finance tab | The commercials, the timesheet and the cost claims |
| `/safety` | The field screen (PRD screen 25): the cases somebody is on, the hazards, the emergency number as a `tel:` link, and one-tap check-in |
| `/admin/workflows` | The case lifecycle itself: stages, the routes between them, and the case types |
| `/admin/recycle-bin` | Now also lists removed tasks |

### The case file is tabbed

PRD 18 gives screen 9 a tab per section, and by the end of M3 the reason was
obvious: the case page had grown to a dozen panels, every one of which ran its
own queries whether anybody scrolled to it or not. The tab lives in the URL
rather than in state, so a particular tab of a particular case is a link
somebody can send, the back button behaves, and the server renders only what
is being looked at. Each tab reads its own data: splitting the work query into
plan, tasks and activity turned one query of everything into three smaller
ones, of which a page view runs one.

The tab bar streams separately from the case, because the counts behind the
tabs are three more queries and the case itself should not wait for a number.
Tabs appear as their milestones land: subjects, evidence, documents, findings
and reports are not stubbed, because a tab leading to an empty screen is worse
than its absence.

### The rules that are the product

- **A case cannot leave its first stage without an objective**, and the
  override that allows it is a recorded decision with an owner.
- **The lifecycle offers only what it is configured to allow**, so PRD 4.2's
  "Draft Report straight to Closed" is not on the menu.
- **A critical case cannot be assigned until its risk assessment is
  approved**, and an overall rating lower than its worst dimension is refused.
- **The original scope is immutable**; a revision needs a second person.
- **Blocked and cancelled tasks each need a reason** (PRD 9.1), which is why
  the Kanban board is deliberately not drag-and-drop: dropping a card into
  Blocked cannot capture why it is blocked.
- **A parent task cannot be completed while a sub-task is open.**
- **An investigation plan cannot be approved by whoever submitted it**
  (PRD 9.3).
- **A check-in schedule needs instructions**, and an unsafe check-in needs to
  say what is wrong. The screen says plainly that recording it does not raise
  the alarm.
- **An incident cannot be closed by the person it happened to, nor by whoever
  reported it** (PRD 16).
- **"Paid" is refused while money is outstanding**, and `outstanding` is a
  generated column so it cannot disagree with the two figures it comes from.
- **Nobody approves their own time, and nobody decides their own expense
  claim.** An approved time entry is then frozen, so a cost report stays
  reproducible.
- **Hours and field days are never converted into each other**: PRD 5.7 asks
  for both, and a conversion needs a working-day length nobody has agreed.

### What the M3 tests prove

- **119 domain tests** with no database: the task and incident state machines,
  the closure checklist of PRD 5.9, the lifecycle rules, the risk and scope
  rules, the payment-status consistency rules and the separation-of-duties
  rules.
- **93 repository tests** against the real Postgres across three files
  (`casework-repository`, `casework-tasks`, `casework-safety-finance`):
  identifier allocation, `completed_at` that cannot disagree with its status,
  an activity log that refuses to be edited by the table owner itself, a
  correction chain readable in both directions, approving version 2 superseding
  version 1 in the same breath, a check-in that cannot be altered, lateness
  computed against the database's clock for the latest check-in only, and the
  CHECK constraints that refuse an unexplained write-off or an injury with no
  detail.
- **Two end-to-end journeys** through the browser, each as the operations
  manager with the administrator loaded for the steps that need a second
  person: tasks, comments, the activity log and the plan in one; safety,
  incidents, the commercials, the timesheet and a cost claim in the other.

## M4: documents and evidence

PRD 6 and 7, screens 15 and 16. The middle of the chain the platform exists to
keep intact: Case to Subject to Source to Information to **Evidence** to
Analysis to Finding to Report.

### Database

`0034_evidence_and_documents.sql` and `0035_storage_buckets.sql`.

- `evidence.evidence_items`, identified by `EV-YYYY-CCCCCC-NNN` from
  `evidence.next_evidence_id(case_id)`, so an item's identifier carries the
  case it belongs to and the sequence restarts per case.
- `evidence.custody_events`, given the **same four locks as the audit log**:
  `INSERT` only for `iims_app` pinned by default privileges, RLS enabled and
  forced with no UPDATE or DELETE policy, a `BEFORE UPDATE OR DELETE` trigger
  that raises, and a separate `BEFORE TRUNCATE` statement trigger. Each row is
  hashed with the one before it and the tail is serialised on a single-row
  `evidence.custody_head` taken `FOR UPDATE`, which is what stops two
  concurrent inserts forking the chain.
- `evidence.integrity_checks`, the permanent record of every time the server
  read a stored object back and computed its own hash. A mismatch is a row
  here, not a flag that can be quietly cleared.
- `docs.folders`, created from `config.folder_templates` the moment a case is
  created, so every case has the same structure and a reader knows where to
  look rather than guessing what somebody named a folder.
- `docs.documents` and `docs.document_versions`, with a trigger that refuses
  any change to an approved version's file: PRD 7.2's lock is at the table,
  not only in the application.
- Three private buckets. `evidence-originals` has an INSERT policy and a
  SELECT policy and **no UPDATE or DELETE policy at all**, which is what makes
  an original genuinely write-once rather than write-once by convention. The
  migration ends with a DO block that raises if such a policy ever appears.

### The two-step hash, and why it is two steps

Supabase Storage exposes no hook that computes a SHA-256, and a Vercel
function caps its request body at 4.5 MB with no setting to change it. So a
file cannot be hashed by the server on the way in without making a 20 MB
statement bundle impossible to upload.

The platform therefore models the honest version of what it knows:

1. The browser hashes the file with WebCrypto and uploads it straight to the
   bucket. The item is registered with `declared_sha256` and reads
   **awaiting verification**.
2. A person with `evidence:edit`, or the scheduler in M7, has the server
   stream the object back out of the bucket and compute its own hash. Only
   then does the item read **verified**, and a disagreement is written as an
   integrity check that nothing in the application can edit.

Both hashes are kept. The screen never shows a declared hash as though
somebody had checked it: the badge says "awaiting verification" and the panel
says in words that the number was computed by the same browser that sent the
file.

### Application surface

- `src/modules/evidence/` with 32 domain tests covering the collection rules,
  the status machine, the custody rules, the correction rule and the version
  rules.
- `src/features/evidence/` and `src/features/documents/`.
- `/evidence` and `/evidence/[id]`, `/documents` and `/documents/[id]`, plus
  two new tabs on the case file.
- `src/components/FileUpload.tsx`, shared by both features. It takes the names
  of the fields it posts, because the same five facts mean different things to
  each: an evidence hash is *declared* until the server has verified it, while
  a document version's hash is simply recorded with it.

### What the M4 tests prove

- **32 domain tests** with no database: an item cannot be collected in the
  future, a working copy must name an original and an original cannot be a
  copy of anything, a movement needs both ends, a correction can only be made
  once against an entry, an item that failed its integrity check cannot be
  cited, and a version label is derived rather than typed so a history cannot
  acquire two v1.0s.
- **22 repository tests** against the real Postgres: the custody ledger cannot
  be edited or deleted by anybody including the table owner, its hash chain is
  recomputed in SQL and shown to hold, a mismatch is recorded permanently with
  both hashes, a second file on an original is refused, every case gets its
  folders the moment it is created, and an approved version's file cannot be
  changed.
- **One end-to-end journey** through the browser with three people: the
  operations manager opens the case and assigns it and is offered no evidence
  control at all, the investigator registers the item, uploads a real file to
  a real bucket, records a movement, corrects it, takes a working copy and
  files a document, and the administrator verifies the stored file against its
  declared hash and approves the version the investigator filed.

## M5: intelligence

PRD 6.4, 8.4 and 15, screens 10, 14 and 17. The two ends of the chain the
platform exists to keep intact: Case to Subject to **Source** to
**Information** to Evidence to Analysis to **Finding** to Report.

### Database

`0036_intelligence.sql` and `0037_entity_reach_for_its_author.sql`, thirteen
tables in `intel`, plus `0038` and `0039`, which extend conflict screening to
the register M5 builds (PRD 8.3).

Three things here are not ordinary CRUD, and each is the reason a part of the
module exists.

**Reliability and credibility are separate columns with separate
vocabularies.** PRD 6.4 rates how far a *source* can be relied on in general
and how far a particular *statement* is borne out, on two different scales. A
reliable source can report something nobody has confirmed, and an unreliable
one can report something that turns out to be true. Collapsing the two into a
single quality number is the most common way an intelligence product misleads
its reader, so no query, no type and no screen in this module ever combines
them: `InformationTable` shows both badges on every row, with different words.

**A human source is protected at the table, not by the UI.** PRD 6.4 makes a
human-source identity STRICTLY RESTRICTED with named-user access only. A
`BEFORE INSERT OR UPDATE` trigger sets `identity_restricted` and raises the
classification for `source_type = 'human_source'` whatever the application
passes, and a CHECK constraint refuses an identity on a source that is not
restricted, which is the half a trigger cannot cover. The identity columns are
then gated inside the select itself, so a query that reached the row another
way still returns no name, and `identityWithheld` tells the screen to say
"withheld" rather than "none".

**A merge moves rows and writes down what it moved.** PRD 8.4 requires merges
to be reversible and never to delete a source record. `intel.entity_merges`
stores the counts and the loser's name, a trigger refuses any rewrite of a
merge record other than recording its reversal, and `reverse` reads that row
rather than trying to work out afterwards which aliases used to belong to
which record. The loser's own name becomes an alias of the survivor, so a
search for the name somebody knew still finds something.

Also in these migrations: `intel.entities.id_reference_encrypted`, written and
read only through two SECURITY DEFINER functions, where the read checks the
permission itself and writes the access to the audit trail; a `merge` verb
added to the `iam.permissions` action vocabulary, because deciding two records
are one thing is not the same authority as correcting a name; and
`intel.can_reach_entity`, which answers "can this person see this entity" for
a record that is not case-scoped.

### Application surface

- `src/modules/intel/` with **50 domain tests** and four repositories.
- `src/features/intel/`, including `TraceabilityStrip` and a lazily imported
  Cytoscape link chart.
- `/entities`, `/entities/[id]`, `/sources`, `/sources/[id]`, `/information`,
  `/information/[id]`, `/findings`, `/findings/[id]`, and three new tabs on
  the case file.
- The recycle bin now covers all eleven soft-deletable record types, which is
  what screen 29 asks for. Rewriting it around one `RemovedRecords` component
  made it shorter than it was with seven.

### The rules that are the product

- **A finding cannot be put forward resting on nothing.** This is the rule the
  whole chain exists for: a statement with no information and no evidence
  linked is an opinion, and the platform's purpose is that every conclusion in
  a client report can be walked back to what supports it. Checked when it is
  submitted rather than while it is drafted.
- **A finding's confidence cannot exceed what its support will carry.**
  `confidenceCeiling` is computed from the credibility of the linked
  statements and the reliability of the sources behind them, and the form
  offers only the levels at or below it, with a hint saying why. A rule that
  teaches rather than one that refuses.
- **Evidence that failed its integrity check supports nothing.** `support`
  excludes `integrity_status = 'mismatch'`, which is what PRD 6.3 is for.
- **"Confirmed" is a claim about corroboration.** The option is absent from a
  brand new statement and appears once something bears it out.
- **Corroboration has to come from a different source.** Two statements from
  the same source are one source saying something twice, and the form offers
  only material from elsewhere.
- **Nobody reviews their own finding**, enforced in the domain and by a CHECK
  constraint, because this one is worth two locks.
- **An accepted finding is not edited back into a draft.** It is withdrawn and
  replaced, so a report that cites F-003 still reads true.
- **A percentage belongs to a holding.** "A director of B, 40%" is refused by
  the table as well as the domain.
- **A relationship nobody can trace cannot be recorded at high confidence.**
  Not refused outright, because an investigator records what they were told
  before they have the extract that proves it. The link chart draws it dashed.

### What the M5 tests prove

- **50 domain tests** with no database: the finding state machine, the
  confidence ceiling across seven combinations of support, the corroboration
  independence rule, the merge preconditions, the holding rules, and the
  traceability strip's ordering.
- **28 repository tests** against the real Postgres: that the ENT identifier
  and the generated normalised name cannot drift apart, that an identity
  reference is ciphertext at rest and every reading of it is audited, that
  "John K. Mensah" and "ABC Holdings Ghana" are found (the two cases PRD 20.2
  names), that the graph walk stops at the depth asked for, that a merge moves
  what it says and a reversal puts it back, that a merge record cannot be
  rewritten, that a human source is protected whatever the application passes
  and its identity is withheld from everybody whose permission stops below it,
  that findings are numbered F-001 per case, and that the strip reaches the
  source behind a linked statement.
- **One end-to-end journey** with two people, which asserts the PRD 16 split
  itself: the operations manager is offered no create control on any of the
  three tabs, the investigator is offered no merge, and neither can review
  their own work.

## M6: reporting, QA, delivery and closure

PRD 5.9 and 10, screens 18 to 21. The far end of the chain: an **Analysis** and
**Finding** become a **Report** that a client reads, and the case then closes.

### Database

`0040_reporting_qa_and_closure.sql`, eleven tables, plus `0042`, which gave the
workflow history a total order.

Four decisions here are the substance of the milestone.

**A citation is a foreign key, not a sentence.** PRD 10.2 requires every
statement in a report to be traceable to the finding or exhibit behind it.
`reporting.section_citations` therefore references `intel.findings`,
`evidence.evidence_items`, `docs.documents` and `intel.information` by id,
with a CHECK constraint that exactly one of the four is set. A citation typed
as free text would be a claim about traceability rather than traceability: it
could not be followed, and it would not break when the finding it rested on
was withdrawn.

**The report's status is a line, and it is narrow on purpose.** PRD 10.1's
seven stages go forward one at a time, back to draft from any review, and to
withdrawn from anywhere before delivery. Nothing else. The only thing a
workflow is worth is the transitions it refuses: Draft straight to Final is a
report nobody read, so `assertReportTransition` has no path for it.

**The QA result is computed from the checklist, never typed.** PRD 10.3 names
twelve checks. `qaResultFromItems` derives the outcome from the answers, so a
review holding a failed check is a return whatever the reviewer meant to
click, and `assertQaReviewComplete` refuses a review with an unanswered item:
an unanswered check is one nobody looked at. Failures must carry a comment,
because "no" without a reason is not something an author can act on.

**Three of PRD 5.9's nine closure requirements are read, not ticked.**
`closureGate` marks each requirement `computed` or `attested`. Whether the
report was approved, whether evidence is accounted for and whether tasks are
closed are read from the records themselves, so nobody can tick "report
approved" when no approved report exists. A checklist that allowed that would
be worse than no checklist, because it would look like assurance.

Approval is withheld from the author at every stage, not only at the final
gate: an author who passed their own work at the supervisor stage has already
defeated the rule. `assertNotDecidingOwnReport`,
`assertNotReviewingOwnReport` and `assertNotApprovingOwnClosure` are three
separate checks because they are three separate points at which the same
person could sign off their own work.

### Archive

Screen 21 is not a separate store. An archived case is a closed case whose
closure was approved, read by the same code, through the same row-level
security, as any other case. That is what makes it searchable four years
later instead of a folder nobody can find anything in, and the read-only part
is enforced where it belongs: the case lifecycle refuses to move a case out of
its terminal stage, so there is no path by which an archived case can change.

### Management reports

PRD 10.4's six figures, read together because that is how a manager reads
them: the case register, turnaround, workload, overdue work, the QA return
rate and revenue against cost. Two points of care:

- Every figure passes through row-level security, so two managers legitimately
  see different numbers. The screen says so rather than presenting them as the
  firm's totals, and `/api/export/management` applies the same permission
  check and reads the same model, which is what stops an export quietly
  showing more than the screen.
- A rate of null and a rate of zero are different claims. "We have never sent
  a report back" is not "we have reviewed nothing", so the QA return rate
  renders as *no reviews yet* rather than 0%.

### Tested

- **43 domain tests** over the status line, the no-self-approval rules, version
  labelling, the QA checklist and PRD 5.9's gate.
- **25 integration tests** against the live database, which prove the parts
  only the database can enforce: that a citation cannot name two sources at
  once, that an approved version is locked, that a report with an uncited
  factual section cannot be submitted, and that closure is refused until every
  computed requirement actually holds.
- **One end-to-end journey** with three people, because PRD 16 gives no single
  person all of it and the journey would be worth little if it did: the
  operations manager opens the case and later closes it, the investigator
  writes the report, and the administrator reviews, runs QA, approves and
  delivers. It builds a real chain first, since a report citing nothing would
  not be testing PRD 10.2 at all, then asserts the things that are only true
  end to end: that a factual section citing nothing is refused by the server
  and not merely warned about, that the author is blocked at the review stage
  rather than only at the final approval, that a failed check leaves a
  reviewer no button but "return for correction", that an unanswered check
  blocks completion, that delivery is offered only once a version is
  approved, that the person who proposed a closure cannot approve it, that
  the archive links to the same case record, and that the management reports
  and their CSV export are now reachable by the manager they are written for
  and refused to an investigator.

---

## Bugs and design changes found during the build

Each of these changed the design or the code, and each was found by a test or
by inspecting the live platform rather than by reading documentation:

1. **MFA was not actually mandatory.** The session layer only required `aal2`
   when a factor already existed, so anyone who had never enrolled got in on a
   password alone. Found by an end-to-end sign-in as a freshly created user
   that landed on the dashboard. Now every session must be `aal2`, and a user
   without a factor is sent to enrol.
2. **Audit inserts failed for want of a sequence grant.** `INSERT` on the table
   is not enough for a `bigserial`; `nextval()` needs `USAGE` on the sequence.
   Found by the containment suite; fixed in migration 0004.
3. **A nested transaction would have deadlocked.** `update` and `setStatus`
   called `findById`, which opened a second transaction while the first was
   held on a pool sized at one. Replaced with a loader that takes the existing
   transaction.
4. **`bump_permissions_version` referenced columns that did not exist** on four
   of the six tables it serves. PL/pgSQL resolves `NEW.<field>` when it plans
   the statement, even in a branch that never runs, and `NEW` is unassigned on
   DELETE. Now reads the row as `jsonb`.
5. **The `auth` schema grants were dead.** See the environment notes above;
   replaced with SECURITY DEFINER functions and the dead grants revoked.
6. **No admin session API exists**, so session revocation moved into the
   database. `ban_duration` alone would have left live sessions working.
7. **`unlockAccount` did not unlock.** It called `update` with no changes,
   which never touched `locked_until` or the failure counter. Replaced with a
   real `unlock` repository method.
8. **The `iims_audit_owner` owner-split was dropped.** Postgres 16 split role
   membership into SET/INHERIT/ADMIN and the implicit creator grant carries
   `SET FALSE`, so ownership reassignment failed. Reasoning kept in 0002.
9. **`PUBLIC` grants were deliberately not revoked**, despite Supabase's
   hardening guide: those statements touch `public`, which the live website
   depends on. Containment is positive instead, and asserted.
10. **Client components could not import the module index**, which pulls in
    `server-only` and postgres. Added the `@/modules/iam/shared` barrel.
11. **Em-dashes removed** from every source file, comment and document, and all
    other non-ASCII typography normalised, per explicit instruction. The PRD
    itself is left untouched as the user's own document.
12. **Every audit write from the application was failing.** `audit.write` ended
    with `insert ... returning audit_id`, and RETURNING reads the row back, so
    it needs SELECT, which `iims_app` deliberately lacks. The integration tests
    missed it because they drive the repository as `postgres`, which has
    BYPASSRLS; the containment test missed it because it inserted directly
    without RETURNING. Found by editing a user in a real browser. The id is now
    generated in the function, so least privilege is kept rather than worked
    around (0015), and a containment test now calls `audit.write` as the
    application role.
13. **Every name and email in the administration screens came back empty.** The
    repository joined `public.profiles` directly, but the website's RLS policy
    on that table reads `id = auth.uid() or public.is_admin()`, and
    `auth.uid()` is null on a direct connection. The data was correct all
    along; the read was filtered out by a policy belonging to the other
    application. Now read through `iam.profile_basics` (0014), and the same
    flawed join was corrected in the role-members and approval-queue queries.
14. **A connection pool of one serialised every query in the process.** Sign-in
    looked like a hang; it was a queue behind a cold TLS handshake. Raised to
    five, which Supavisor fans in.
15. **The audit filter could not read its own action list.** `select distinct
    action from audit.audit_log` is denied for an INSERT-only role, so it now
    goes through a permission-checked SECURITY DEFINER function (0013).
16. **`extensions.gen_random_uuid()` was not callable** by the application role,
    which has no USAGE on that schema. `gen_random_uuid()` has been a Postgres
    built-in since 13, so it needs no extension at all; USAGE was also granted
    explicitly for the pg_trgm and unaccent functions that conflict screening
    will need in M2 (0016).
17. **Four controls labelled "Reason" on one page.** Ambiguous for anyone using
    a screen reader, and the reason the tests could not address them either.
    Each is now named for what it explains.
18. **`forbidden()` needs `experimental.authInterrupts`.** It compiles without
    the flag and fails at runtime, so the flag is enabled and the 403 and 404
    screens are ours.
19. **A shared browser page across a spec file was fragile.** One test closing
    or navigating it broke every test after it. Replaced with Playwright's
    stored-session pattern, so each test gets a fresh page and the mandatory
    MFA round trip is paid once.
20. **"Sign out" signed the user out of every device.** supabase-js v2 defaults
    `signOut()` to GLOBAL scope, so the plain menu item did exactly what "Sign
    out of all devices" beside it does, and signing out at a desk also signed
    an investigator out of the phone they were carrying in the field. Now
    explicitly `scope: "local"`, with the global variant reserved for the
    option that says so. Found because the end-to-end suite's stored
    investigator session stopped working after an unrelated sign-out test.
21. **Audit rows never recorded who did it, readably.** `actor_email` was only
    set when a caller passed it and no caller ever did, so every human action
    stored a uuid and a null address, and the audit screen renders a null
    address as "system". The trail therefore showed real people's actions as
    if the platform had done them by itself. `audit.write` now resolves the
    address itself through the shared-directory function, and the reader
    resolves it for rows written before the fix, since the trail is
    append-only and cannot be backfilled in place (0017).
22. **The two-person rule was a dead end.** A request could be approved but
    never applied: re-attempting the change simply raised another request.
    The gate now looks for an existing approval first, applies the change, and
    marks the request applied.
23. **Inline row actions deliberately show no success banner**, because the row
    disappearing is the feedback. Tests asserting the banner were asserting
    something designed not to appear; they now assert the effect.
24. **Removing an account destroyed its own confirmation.** The removal form
    lived inside a block rendered only while the account was live, so the
    revalidation that followed the removal unmounted the form and took the
    "Account removed" banner with it. An administrator saw nothing at all and
    had no way to tell whether it had worked. A removed account's page now
    carries the notice and a Restore button instead of the status controls,
    which is also the more useful screen.
25. **A rate-limited sign-in was reported as a wrong password, and counted
    against the account's lockout.** Any error from `signInWithPassword` was
    treated as a credential rejection, so a 429 or a Supabase outage both told
    the user their password was wrong *and* spent one of their five attempts.
    Five such requests from an office sharing one address would have locked a
    valid account, with nothing to explain why. The same flaw was in the MFA
    verify path, where it matters more: that limit is 15 a minute per IP and is
    not configurable. Failures at 429 or above are now reported as the platform
    being briefly unavailable and are not recorded against the account.
26. **`asActor` in the test helpers masked every rejection it was used to
    assert.** A statement a policy rejects aborts the transaction, so the
    helper's cleanup query failed too and the caller saw "current transaction
    is aborted" instead of the refusal it was checking. It now wraps the body
    in a savepoint. The same applies to a test asserting two refusals in a
    row, which is why `conflict-screening.test.ts` has its own savepoint
    helper.
27. **A timestamped fixture name at module scope is not stable across a
    Playwright run.** Playwright starts a fresh worker after a failure, which
    re-imports the spec and changes the timestamp, so every later test looked
    for a fixture created under a different name. The CRM journey is now one
    test with steps, which cannot drift that way.
28. **The dev machine is 120ms from the database region**, which is not a code
    defect but did fail three tests whose behaviour was correct. A page render
    costs about 18 round trips and a mutation with its revalidation about 27,
    so a confirmation banner can legitimately take 6 to 8 seconds: the 10s
    assertion ceiling was too tight and is now 25s. `IIMS_DB_DEBUG=1` prints
    one line per statement so this is measurable rather than guessed at. The
    administration shell's three permission questions were also collapsed into
    one round trip while this was being traced.
29. **A client's conflict checks were filtered in memory from a system-wide
    page.** The client page asked for the ten most recent checks across the
    platform and then kept the ones belonging to that client, so once eleven
    newer checks existed anywhere the page would have shown "Not screened" for
    a client that had been screened, and an approval would have looked blocked
    for no visible reason. The filter is now in the query, and an integration
    test creates newer checks against another client to prove it.
30. **The application role held DELETE on the CRM tables it must never
    erase.** 0002 grants `select, insert, update, delete` across the IIMS
    schemas, which is right for `iam`, where removing a role assignment or an
    override genuinely is a deletion, and wrong for `crm`, where PRD 3.5 makes
    every removal a soft delete and PRD 4.1 keeps intake history forever. The
    policies already denied it, because there is no DELETE policy on any crm
    table and RLS denies by default, so nothing was ever at risk. The
    privilege was wider than the guarantee all the same, and would have become
    a real hole the first time somebody added a permissive policy. Migration
    0021 revokes DELETE and TRUNCATE on the schema and on anything added to it
    later, and asserts the outcome so a future widening of 0002 fails there
    rather than silently. Found by a test written to confirm the claim rather
    than to assume it.
31. **"It threw" and "it changed nothing" are different guarantees.** The first
    version of that same test expected an UPDATE on `crm.conflict_matches` to
    raise for the application role. It does not: there is no UPDATE policy, so
    RLS filters every row out, the statement affects nothing and the
    immutability trigger never fires because there is no row to fire for. The
    trigger is what stops the table owner, which `conflict-screening.test.ts`
    asserts separately as `postgres`. The test now pins down the behaviour that
    is actually true.
32. **The standalone "run a conflict check" screen could only ever fail.** A
    check has to belong to an enquiry, an engagement or a client, which the
    database enforces and the use case checks. Reached from a client, an
    enquiry or an engagement the subject comes with the link, but the button on
    the conflict list opened the same form with no subject at all, so
    submitting it was guaranteed to be refused. The form now asks which client
    the check is about when no subject was supplied, and says why. Found
    because the end-to-end journey screened from a bare URL and the redirect
    never came: worth noting that it presented as a hang rather than as an
    error, because `waitForURL` inherits an unlimited navigation timeout, so
    the journey's waits are now explicitly bounded.
33. **A scope change request could be raised and then never decided.**
    Migration 0022 attached `iam.touch_row()` to
    `casework.scope_change_requests`, and that trigger assigns
    `new.updated_by`, but the table was given `requested_by` and no
    `updated_by`. Every UPDATE therefore failed with `column "updated_by" does
    not exist`, which made the whole scope-change workflow of PRD 5.4
    unreachable past its first step. Reading 0022 would not have shown it: the
    table is correct in isolation and the trigger is correct in isolation.
34. **"The newest risk assessment" was not well defined.** `assessed_at`
    defaults to `now()`, which is the TRANSACTION timestamp and so identical
    for two rows written together, and the ordering was `assessed_at desc`.
    The assessment reported as in force was therefore arbitrary among ties,
    and the case's cached `risk_level` could disagree with the screen. A
    monotonic `seq` settles it, and it is also the better answer to the
    question: the assessment in force is the last one recorded, not the one
    with the latest clock reading, which two assessors a minute apart could
    tie on. Its sequence needed its own grant, the same trap as the audit log
    in 0004.
35. **A case could not be backdated, which is what migrating off Excel needs.**
    `opened_at` defaulted to `now()` and the repository offered no way to set
    it, while `case_target_after_opening` compares the target against it. A
    case entered for work that started three weeks ago, with a target that has
    already passed, was therefore rejected: precisely the case PDDC has most
    of while it moves off the manual process. The constraint is right and
    stays; `openedAt` is now a create input.
36. **Every case reported itself as on time.** `days_to_target` was computed as
    an interval and read as `row.target_interval?.days`, which the driver does
    not reliably hand back in that shape, so the value was `undefined`, the
    comparison was skipped and `isOverdue` was always false. Subtracting two
    dates gives a plain integer and needs no driver cooperation. Worth noting
    how quiet this one was: nothing errored, no column was missing, and the
    overdue filter simply never matched anything.
37. **A stale `next start` served a build that no longer existed.** `pkill` does
    not kill the process on Windows, so a server started before a rebuild kept
    the port and answered with a 500 for a chunk that had been replaced, which
    presents as a page that renders but is completely inert. Worth knowing
    because it looks exactly like a hydration bug: check the port's owner with
    `Get-NetTCPConnection -LocalPort 3100` and stop it by pid.

38. **Approving an engagement destroyed its own confirmation**, the same fault
    as 24 in a different place. The approval form lives inside a block
    rendered only while the engagement is awaiting approval, so a successful
    approval unmounted the form and the banner with it, and the approver saw
    nothing at all. The panel now states the approval durably, naming who
    approved it and when, which is also the right screen for anybody arriving
    later. Worth noting that this had never been caught by a test: the
    assertion for it was written early but the journey had always failed
    before reaching that step.
39. **`now()` is the transaction timestamp, and that broke ordering three
    times.** Every statement in one transaction sees the identical value, so a
    table whose order depends on a `now()` default has no defined order among
    rows written together. It surfaced as the risk assessment in force being
    arbitrary among ties (0026), task comments not reading forwards, and
    latently in the activity log, whose order falls back on `recorded_at`. The
    third occurrence was fixed as a rule rather than a third time
    individually: migration 0028 puts a monotonic `seq` on every history table
    and the queries order by it. Not merely a test artefact: a batch import, a
    retry, or any code path that writes two rows in one transaction hits it in
    production, and the symptom is a silently wrong "most recent" rather than
    an error. The accompanying trap, hit for the third time too, is that a
    `bigserial` needs a grant on its sequence beyond INSERT on the table.
40. **A row-level security policy that reads the table it protects refuses
    every `INSERT ... RETURNING`.** The cases policies were written in terms of
    `can_reach_case(id)`, which is correct and reads well for every child
    table, and wrong on `casework.cases` itself: the function is STABLE and
    queries `casework.cases`, so it evaluates against the snapshot from the
    start of the statement, in which the row being inserted does not exist.
    Postgres applies the SELECT policy to the rows an INSERT returns, so
    opening a case failed with `new row violates row-level security policy`,
    which points at the WITH CHECK and is not where the fault was. The
    identical statement without `RETURNING` succeeded, and every direct test
    of the permissions said the insert should work. Migration 0029 rewrites
    those policies over the row's own columns, keeping one definition of the
    rule in `casework.can_reach()`. A test now asserts the policy's shape,
    because the failure mode is invisible to a test that holds no actor.
41. **The cases UPDATE check read the classification as it was, not as it would
    be.** The quieter half of the same fault: a WITH CHECK sees the new row,
    but going through `can_reach_case` made it re-read the old one, so raising
    a case's classification above the editor's own clearance would have been
    allowed. Fixed by the same rewrite.

42. **A soft delete was impossible on three tables, and the error pointed
    somewhere else.** Removing a task comment failed with `new row violates
    row-level security policy for table "task_comments"`, which reads like a
    permission fault on the write. The author held the permission, the UPDATE
    policy's USING and WITH CHECK both passed, and an ordinary UPDATE of the
    same row by the same actor succeeded: only the UPDATE that set
    `deleted_at` was refused. The cause is a rule that is easy to miss:
    **Postgres applies the SELECT policies to the NEW row of an UPDATE**, so a
    table whose SELECT policy says `deleted_at is null` cannot have a row
    soft-deleted by anybody, because the row the statement produces is one the
    policy forbids its author to see. Proven against the live database as
    `iims_app` rather than reasoned about. Three tables had it:
    `casework.task_comments`, `casework.case_communications` and
    `crm.client_documents`. Migration 0033 gives each a policy admitting
    removed rows to whoever may remove them, and asserts the rule over every
    soft-deletable table so a later milestone that forgets it fails the
    migration rather than production.
43. **A refused submission threw away what somebody had typed.** React resets
    a form when its action's transition completes, which is right after a
    successful save. The trouble is when it happens: a server action in Next
    also refreshes the route, so the transition ends two to four seconds after
    the reply arrives. Measured, not theorised: somebody who read a validation
    error, corrected the field and clicked save inside that window submitted
    the reset values instead of their own, which on the task status form moved
    the task to whatever the dropdown had fallen back to. `ActionForm` now
    records the latest values as they are entered and restores them when an
    action comes back with an error, so a correction made while the reply was
    in flight survives. A successful save still clears the form.
44. **Dates were Date objects where every type said string.** postgres.js
    parses `date` and `timestamptz` into `Date`, while every row type and
    domain entity in the codebase declares them as `string`. The two agreed
    often enough to hide it, because `new Date(value)` accepts a Date and so
    does `toLocaleString`. They disagreed the moment a form prefilled a date
    input: `record.dueDate?.slice(0, 10)` on a Date is a TypeError, and a
    TypeError in a server component is a page that will not load at all.
    Three features had it latent (tasks, clients and engagements) and nothing
    would have caught the fourth. Fixed in one place, the database client, so
    the declared type is the true one; and the integration tests now build
    their client from the same type configuration, because a test that
    received Dates where production receives strings is a test that passes
    while the screen it covers throws.
45. **Removing a task was offered to somebody who could not then see it.**
    PRD 16 grants delete on tasks to no role, because work is retired by
    cancelling it with a reason. The removal action checked `tasks:edit` while
    the policy revealing a removed task asked for `cases:delete`, so an
    operations manager could remove a task and then never see it again: not on
    the task page, which returned a 404, and not in the recycle bin. Migration
    0032 keys the reveal on `tasks:delete` and the action checks the same
    thing, so whoever can remove a task can still see it. In practice that is
    the Administrator, through the PRD 3.5 wildcard.
46. **A controlled form field discarded a choice made before hydration.** The
    task status dropdown was a controlled React select, so a value chosen
    before the JavaScript arrived was replaced by the state's value when
    React hydrated. On a slow connection somebody would pick "Blocked",
    submit, and move the task somewhere else. The fields that only drive
    labels are now uncontrolled with `defaultValue`, which keeps what was
    entered; the one posted field elsewhere with the same shape was fixed too.
47. **The case page read the staff directory three times.** Each streamed
    section of the case page needed the same two pieces of reference data, and
    asked separately: four round trips to a database 127ms away, three of them
    for an answer already in hand. `src/lib/reference.ts` memoises both per
    request with React's `cache`, keyed on the actor, because both reads go
    through row-level security and two people on the same page can
    legitimately get different answers.
48. **Three package scripts pointed at files that did not exist.**
    `db:seed`, `seed:demo-case` and `seed:perf` were listed in `package.json`
    and in the README while their scripts had never been written: seeding
    happens in migration 0009. A command that fails with "cannot find module"
    is worse than one that is absent, so they are gone until the milestone
    that needs them.

49. **A refused submission could not be corrected on the status form, and the
    correction submitted something else.** Found by the task journey and then
    measured directly against the running server rather than inferred: the
    status dropdown posted "In progress" when "Blocked" had been chosen. Two
    separate faults, both in the same few seconds. The dropdown was a
    controlled React field, so a choice made before hydration was discarded;
    and React resets a form when its action's transition completes, which with
    Next's route refresh is two to four seconds after the reply arrives, so
    the correction typed in that window was wiped before the click that
    submitted it. The fields that only drive labels are now uncontrolled, and
    `ActionForm` restores the latest values when an action comes back with an
    error. Verified by watching the live form across the whole window: the
    values hold, and the correction submits what was chosen.
50. **Three forms confirmed their own success by removing it.** Drafting a
    plan, recording a safety plan and saving the commercials each replace the
    form with the record it created, so the form's confirmation unmounts along
    with the form. The record on screen is the better confirmation, and the
    tests now assert that. Checking out of a site had no durable signal at all,
    which was worse: the button and its banner both disappeared and nothing
    said it had worked. The check-in control now states the last event, so a
    check-out is acknowledged by something that stays.
51. **A test premise that was wrong about the product.** The journey tried to
    assemble a police reference with no police notification, which a domain
    rule refuses. It cannot be assembled on the screen: the reference field
    belongs to the checkbox and goes when it is unticked. The test now asserts
    that, which is the stronger statement, and the rule stays as the backstop
    for anything reaching the database another way.
52. **A Playwright action on a missing element waited 26 minutes.** The tasks
    journey timed out with nothing but "test timeout exceeded". Profiling the
    trace showed eighteen steps between 0.2s and 53.5s and one at **1253s**,
    inside which `selectOption` on the plan review control was still running
    when the test was killed. The control was absent: the case page had become
    tabbed and the approver was still being sent to the case root, which is
    the summary tab. The cause was one missing `?tab=plan`, but what made it
    cost two full runs to find is that **Playwright's default action timeout
    is 0**, so an action on an element that never appears waits for the whole
    test timeout and reports the wrong thing. `actionTimeout` is now 50s, a
    little above the assertion timeout, so a missing element fails with its
    own name in the message.
53. **Every tab of every case file was a server error, and the tests said so
    in a way that hid it.** The case page's tab counts had grown a query
    against `evidence.evidence_items`, and migration 0034 had not been applied
    yet, so `getCaseTabCounts` threw and the error boundary replaced the whole
    page. The failing assertion reported only that a panel was not visible.
    Reading the web server's own output from the run is what named it:
    `relation "evidence.evidence_items" does not exist`. Applying the
    migration fixed it, and the lesson recorded here is that the server log
    belongs in the failure report, not the terminal scrollback.
54. **A deliberate database refusal poisoned the rest of its transaction.** An
    integration test asserted that the trigger refuses a change to an approved
    document version, then carried on and asserted that approving twice is
    refused with a readable message. The second assertion failed with
    "current transaction is aborted, commands ignored until end of transaction
    block": in Postgres *any* error aborts the whole transaction, so every
    statement after the expected one failed with a misleading cause. The
    refusal is now taken inside `tx.savepoint(...)`, which rolls back to the
    savepoint and leaves the transaction usable. Worth stating plainly because
    it is a property of Postgres and not of the test framework: a test that
    expects more than one database error, or expects one and then keeps
    working, needs a savepoint per expectation. The repositories are
    unaffected, and deliberately so: none of them catches a database error, so
    a failure propagates out and the transaction is rolled back whole.
55. **A comma-separated tag field became one tag.** The document forms post
    tags as a single field, and the schema normalised each posted value
    without splitting it, so "banking, kyc" became the tag `banking--kyc`.
    Nothing would have failed; a search for `kyc` would simply have returned
    nothing, which is the kind of defect that survives a demo. The transform
    now splits on commas before normalising, and tolerates both one field with
    several tags and several fields with one each.
56. **The risk approval confirmed itself by removing itself.** The fifth
    instance of the pattern in bug 50, found by an end-to-end step that
    asserted the banner. Approving an assessment is the last thing there is to
    do to one, so the form goes when it succeeds and takes its message with
    it. Unlike the earlier four this one is correct behaviour: keeping a dead
    form on screen to hold a message would be worse than the panel's own
    record, which already says "Approved by ... on ...". The test now asserts
    that record and that the button has gone, which is the stronger statement.

57. **The role that registers subjects could not read back what it had
    registered.** An entity is not case-scoped, so `intel.can_reach_entity`
    answered "can this person see it" from the cases the entity is a subject
    of. An Investigator holds `entities:view` at `assigned` scope, and a
    freshly registered subject is on no case yet, so the write succeeded and
    the read came back empty: the row existed and the screen reported a
    failure. Found by working out what the end-to-end journey would do before
    running it, and confirmed against the live permission catalogue rather
    than assumed. Migration 0037 adds the clause a person would state without
    being asked, that whoever recorded an entity can see it, and two
    integration tests hold it: one that the author can read it back, one that
    a second investigator still cannot. The alternatives were worse and are
    written down in the migration: attaching every entity to a case on
    creation would make a cross-case register impossible, and reading back
    with the check suspended is the shape of hole that quietly stops
    need-to-know meaning anything.
58. **No role can see a human source's identity, and that is correct.** The
    first version of the integration test assumed an Operations Manager could
    read back the human source they had just recorded. They cannot: their
    ceiling on `sources` is CONFIDENTIAL and the trigger raises a human source
    to STRICTLY_RESTRICTED, so the source is above them entirely. Checking the
    seeded matrix rather than arguing with the test showed that no role's
    ceiling reaches it, which is exactly PRD 6.4's "named-user access only":
    the identity is reachable by an administrator, or by a named user given an
    explicit override. The seed was left as PRD 16 writes it rather than
    quietly widened, the test now uses the roles that really hold the
    permissions, and the screen says "withheld" rather than "none" so a reader
    is never told something false.
59. **Two integration assertions were testing the wrong layer.** The harness
    connects as `postgres`, which Supabase grants BYPASSRLS, so an assertion
    that a row is invisible to a lower-cleared actor passes or fails for
    reasons that have nothing to do with the policy. The row-level rules are
    asserted in `app-role-containment.test.ts`, which connects as `iims_app`;
    what this file can assert, and now does, is the second lock: the identity
    columns are gated inside the select itself, so even a query that reached
    the row another way returns no name.
60. **`merge` was not a verb the permission catalogue allowed.** PRD 8.4 makes
    merging a separate authority from editing, so it needs its own action, and
    `iam.permissions` has a CHECK constraint listing the fourteen verbs. The
    migration failed on it. That is the constraint doing its job: the
    vocabulary is a check constraint rather than a Postgres enum precisely so
    it can be replaced in one statement, which is what 0036 now does before
    inserting the permission.
61. **A comma-separated tag field became one tag** (M4). The document forms
    post tags as a single field, and the schema normalised each posted value
    without splitting it, so "banking, kyc" became `banking--kyc`. Nothing
    would have failed; a search for `kyc` would simply have returned nothing,
    which is the kind of defect that survives a demo.
62. **The schema documentation covered half the database.** `scripts/doc-schema.mjs`
    listed five schemas, so the thirteen tables M4 and M5 added were absent
    from `docs/erd.md` and nobody would have known. It now lists all ten,
    including the three with no tables yet, so the document grows with the
    build rather than needing somebody to remember.

63. **A control was offered to somebody who could not use it, on seven
    panels.** The `Expandable` shell every intelligence panel is built from
    rendered its open button unconditionally, and the form inside said "you
    cannot record a source on this case". That is the one thing this platform
    does not do anywhere else: PRD 16's whole point is that the screen offers
    the transitions the API would allow. Found by the end-to-end step that
    asserts the Operations Manager is offered no create control on the
    subjects, sources and findings tabs, which is a step written to prove the
    permission split rather than to find a bug. `canOpen` now decides whether
    the button exists, and the dead "you cannot" branches went with it.
64. **A conflict check raised "column reference searched_term is ambiguous".**
    Migration 0038 named its CTE columns after the function's own OUT
    parameters, and inside a plpgsql function those are in scope as variables,
    so `distinct on (searched_term, matched_id)` is ambiguous and Postgres
    refuses the whole query. Every conflict check failed, which also took out
    the case fixture that every other journey depends on. Caught at once by
    the existing conflict-screening tests, which is the reason they were
    written against the function rather than against the screen. 0039 gives
    the intermediate columns names that cannot collide; the
    `#variable_conflict use_column` pragma would also have worked and is
    worse, because it makes the function depend on something a later reader
    has to know about.
65. **Two aliases that normalise to the same string cannot both be recorded,
    and a test assumed they could.** "Tamale Produce Exporters" and "Tamale
    Produce Exporters Co" are one alias once the corporate furniture is
    stripped, and the unique index on `(entity_id, normalised_alias)` refused
    the second. The constraint is right, and the test now uses two names that
    really are different.

66. **Every page view rendered every page in the sidebar, on the server.**
    Next prefetches every `<Link>` that comes into view. The sidebar is
    fourteen links, each to a permission-filtered register backed by several
    database reads; the case file's tab bar is nine links to the same heavy
    route with a different query string; and every table row links to a detail
    page. Opening one case page therefore took the browser's request list from
    one GET to several dozen, each one a full server render opening
    transactions against a database 130ms away through a pooler that serves
    this project from a small server pool. It got worse with every milestone,
    because every milestone adds a register to the sidebar and a tab to the
    case file. Found by logging every failed request during a form submission
    and seeing fourteen sidebar destinations, the case page nine times, and
    one entity page per row. `@/components/AppLink` is now the only link the
    presentation layer may import, eslint enforces it, and prefetching is
    opt-in with a reason. Case page load went from 13.8s to 3.3s in the same
    measurement where nothing else changed.
67. **A write landed and the screen said it was still saving, about half the
    time.** The worst failure shape a form can have: the user cannot tell
    whether to try again, and trying again is how you get two of everything.
    It took a long bisection because every obvious suspect was innocent. The
    row was always written. The server always answered 200 with a complete
    body of 108 to 127 kilobytes. The Supabase auth endpoint answered in
    0.26 to 0.84 seconds across eight consecutive calls. No SQL error, no
    browser console error, no page error, no duplicate row, no stuck lock, and
    22 of the database's 60 connections in use. Changing the pool size (4, 10,
    25) changed nothing; cutting the case page's tab-bar reads from nine
    transactions to three changed nothing; removing the prefetch storm above
    made the page four times faster and changed nothing.

    What it was: `revalidatePath`. Removing those calls from one action made
    it settle in about eight seconds, reliably, across repeated runs. Scoping
    the call to the page segment did not help. The call makes Next append a
    fresh render of the route to the action's own reply, and on a route of
    this size that wedges the reply.

    The fix rests on something worth stating: **this application caches no
    route.** No `unstable_cache`, no `"use cache"`, no `export const
    revalidate`, and every route in the build output is dynamic, because each
    request reads the database through row-level security and two people on
    the same URL must be able to see different things. So `revalidatePath` was
    never invalidating a cache here; its only effect was that appended render.
    The call sites still declare which screens a write affects, because that
    is worth reading, but the declaration now goes through
    `@/lib/revalidate`, and the screen is brought up to date by
    `router.refresh()` in `ActionForm` once a write has succeeded. That is a
    separate request which cannot take the reply down with it: the
    confirmation appears at once and the panel catches up a moment later.

    Measured after the change, on the two actions that failed most: subject
    registration 8.0s and 7.8s where it had been hanging at over 150s, and
    three consecutive source recordings at 4.4s, 4.5s and 4.5s where one in
    three had hung. `@/lib/revalidate` holds the full measurement and says
    what to re-run if a later Next release fixes the underlying behaviour.
68. **The platform did not survive its pooler closing a connection.** Caught
    on the way to the above: `write CONNECTION_CLOSED` from the Supavisor
    transaction-mode pooler, part way through an action's transaction, after
    the insert and the audit write had been sent. A lost connection means the
    transaction did not commit, so there is no half-applied write to reason
    about and the choice is between doing the work once and not at all.
    `withActor` now retries once, and only for connection-level codes:
    anything the database decided is an answer and is never repeated. A user
    who hits it twice is told the connection dropped and nothing was changed,
    which is actionable, rather than "something went wrong", which is not.

69. **Nobody could record a human source.** PRD 6.4 says "Human-source
    identities carry additional access controls (STRICTLY RESTRICTED by
    default, named-user access only)", and migration 0036 read that as
    raising the source record to STRICTLY_RESTRICTED. The arithmetic of PRD
    16 then made the feature impossible: `sources:create` goes to the
    Investigator at a CONFIDENTIAL ceiling, the Analyst and Forensics at
    CONFIDENTIAL and the Supervisor at RESTRICTED, and no role reaches
    STRICTLY_RESTRICTED. The trigger raised the row in the same statement as
    the insert, so the INSERT policy evaluated the raised classification and
    refused it. Every attempt failed, including by the role that actually
    meets human sources. Found by the end-to-end journey rather than by
    reading, because each half looked right on its own.

    Migration 0043 reads the sentence as it is written: the **identity** is
    strictly restricted, not the record. What a source said is intelligence
    the case team has to be able to read, and classifying the record above
    the team would hide the investigation from the people conducting it,
    which cannot be what a requirement about protecting a source means. The
    identity is protected independently and always: the trigger sets
    `identity_restricted` for every human source, a CHECK constraint refuses
    an identity on a source that is not restricted, and the identity columns
    are gated inside the select on a STRICTLY_RESTRICTED check whatever the
    row's own classification is. Since no role's ceiling reaches that, an
    identity is readable by an administrator or by a named user given an
    explicit override, which is precisely "named-user access only".

    Recorded below as a question for PDDC, because it is a reading of an
    ambiguous sentence rather than a certainty.

70. **A transient auth failure logged everybody out, in an infinite loop.**
    `/clients/new` started returning `ERR_TOO_MANY_REDIRECTS`, which no
    earlier run had produced. The cause is a disagreement the architecture
    had built in and nobody had noticed: the proxy decides who is signed in
    from `getSession`, which parses the cookie, and the page decides from
    `getUser`, which validates it against the auth service. The two agree
    almost always, and when they disagree the result is not a wrong answer
    but a loop: the page redirects to `/login`, the proxy sees a cookie and
    redirects to `/dashboard`, the page redirects to `/login`, forever.

    A cookie that parses but no longer validates is not a rare state. A
    revoked session is one. So is a refresh token already consumed by another
    client, which is what two concurrent test runs on one port had produced.

    Two fixes, because there were two faults. `requireActor` now redirects to
    `/login?stale=1`, and the proxy treats that as the page telling it the
    cookie has been rejected: it clears the auth cookies and renders the
    login form, which is the one place in the request that can clear them,
    since a server component cannot write cookies. The loop cannot restart on
    the next request either.

    The second fault was worse and was hiding inside the first.
    `getUser` returns a null user both when the caller has no session and
    when the auth service could not be reached, and the code read both as
    "not signed in". The auth service has been measured from here at 0.3s,
    3.7s and 37s on three consecutive calls, so an outage is a normal event,
    and treating one as a sign-out logs out a working session. It now
    distinguishes them: a 4xx is final, a transport failure or a 5xx gets one
    retry and then throws, so the user is told the sign-in service is
    unreachable instead of being signed out of a session that was valid.

71. **A mechanical rename corrupted four pieces of user-facing text.** The
    `next/link` to `AppLink` rewrite that fixed the prefetch storm also
    rewrote the word "Link" wherever it appeared, so the findings screen
    offered a button labelled **"AppLink something"** and two paragraphs told
    the reader to "AppLink the information or the evidence it rests on".
    `tsc` and lint were clean throughout, because a corrupted string is still
    a valid string. Found by an end-to-end test looking for the button by its
    label.

    The lesson recorded rather than the fix: a rename applied across 41 files
    needs a pass over what it changed inside string literals, because the
    type system cannot help there and the compiler will not complain.

72. **PRD 10.4 was built, reachable, and useless to the people it is for.**
    The management reports screen and its CSV route both check
    `reports:export`. That permission was never in the catalogue, so
    `iam.has_permission` answered false for every role and the only person
    who could open the screen was an administrator, by virtue of the
    administrator wildcard. Nothing errored; the feature was simply invisible
    to the Operations Manager, the Supervisor and the CEO, which is who PRD
    11 says reads firm-wide figures.

    Migration 0044 adds the permission and grants it to those roles, scoped
    `all` for the firm-wide ones and `team` for the supervisor, and bumps
    `permissions_version` so it takes effect without anybody signing out
    again (PRD 3.4). It asserts both directions: the four roles have it, and
    the investigator does not. Their own reports are theirs to write; the
    firm's figures are not theirs to take out in a file.

    Worth stating plainly: a permission check against a permission that does
    not exist fails closed, which is the right default and the reason this
    was silent rather than a vulnerability. It also means a gate can be
    written for a permission nobody will ever hold, and nothing will say so.

73. **A click that landed before React hydrated was silently discarded.** The
    intel journey failed waiting fifty seconds for a form field, having
    clicked the button that opens it. The button was present and correct: the
    panel is server-rendered, so it is visible, stable, enabled and
    hit-testable before hydration, which satisfies every actionability check
    Playwright makes. A click in that window hits plain HTML with no listener
    attached, and nothing happens.

    This is a test-harness fault rather than a product one, but it had been
    costing runs for a while and misreporting where the failure was: it
    surfaces as a missing field in whatever step comes next. `openForm` now
    asserts that the control it clicked stopped matching, which is what both
    panel shapes do when the form opens, and clicks again if it has not. The
    shared `Expandable` also now publishes `aria-expanded`, which it should
    have done anyway: a button that shows and hides a region has to say which
    state that region is in.

74. **The author of a submitted finding was never told why they could not
    review it.** The refusal message existed and was correct, but it only
    rendered when there was nothing at all on offer. An author can still
    withdraw their own finding, so the offer was never empty, and what they
    actually saw was a status control holding "withdraw" alone: accepting and
    returning were simply absent, with nothing saying they exist and are
    deliberately somebody else's.

    "The screen says why rather than offering a form the server would refuse"
    is the rule everywhere else in this platform. A control silently missing
    its two main options is the same failure in a quieter form, and quieter
    is worse: a user who is told no learns the rule, and a user shown a
    shorter list learns nothing. The message is now stated whenever it is
    true, with the withdraw control under it.

75. **The merge permission was held by a role that could not reach it.** PRD
    8.4 makes resolving a duplicate an "authorised confirmation", so
    migration 0036 gives `entities:merge` to the Supervisor and the
    Operations Manager. PRD 16 gives the Operations Manager view only on
    Subjects/entities, so they hold no `entities:edit`. Resolving a match is
    two steps on purpose, deciding then merging, because a single button
    would leave the merge log saying only that somebody pressed a button. The
    decision step, screen and action both, was gated on `entities:edit`.

    So the platform granted the merge to the one non-administrator role that
    could never perform the step that has to come first. Both halves are now
    satisfied by either permission, through a new `requireAnyPermission` that
    makes each caller name exactly which permissions it accepts.

    **This is the third instance of one pattern and it is worth naming.** A
    feature is built, a permission is granted for it, and the two are keyed
    to each other through a third thing that does not line up:
    `reports:export` was checked and never seeded (entry 72), the management
    screen was therefore administrator-only, and here a granted permission
    sits behind a gate naming a different one. Each was silent, because a
    permission check that cannot pass fails closed and a UI that renders
    nothing looks exactly like a UI correctly showing you nothing.

    `tests/integration/permission-catalogue.test.ts` catches the first shape,
    a gate naming a permission that does not exist. It cannot catch this one:
    both permissions here exist. What catches this one is an end-to-end
    journey that performs the act as the role PRD 16 gives it to, which is
    why the intel journey runs as two people and why that is worth the time
    it costs.

76. **The side navigation could not be scrolled, so its last sections were
    unreachable.** Reported from use, not found by a test, and the tests
    could not have found it: every one of them navigates by URL, so no test
    has ever needed to click a sidebar entry that was off-screen.

    `sticky` with no height is the trap. The list pinned itself below the top
    bar and stayed there, so scrolling the page moved the main column while
    the entries past the fold stayed exactly where they were, rendered and
    permanently out of reach. There was no scrollbar and no clipping, so
    nothing looked broken; the sections were simply missing.

    Seventeen entries at roughly 38px is about 670px of list below a 64px top
    bar, so any browser window shorter than about 740px lost the bottom of
    it, which is an ordinary laptop with ordinary browser chrome. It also got
    worse with every milestone, for the same reason the prefetch storm did:
    each one adds a register to the sidebar.

    Now constrained to `calc(100dvh-4rem)` and scrollable, with
    `overscroll-contain` so reaching the end of the list does not start
    scrolling the page behind it. The mobile "More" sheet was already correct
    at `max-h-[80dvh]`, and the case tab bar already handles its own
    horizontal overflow, so this was desktop chrome only.

    Worth noting what this says about the test suite: it exercises what the
    platform does, thoroughly, and almost nothing about whether the chrome
    can be operated at a given window size. The manual responsive pass in the
    plan is not a formality.

77. **A merge was neither reversible nor non-destructive, and PRD 8.4
    requires both.** Three defects in one operation, found in sequence by one
    end-to-end step. Taken together they mean **no entity merge had ever
    completed in this platform**, and the parts that would have run were
    losing data that could not be recovered.

    **It could not run at all.** `iims_app` holds DELETE on the four genuine
    join tables and on nothing else, because 0036's privilege comment sets
    the rule plainly: "everything that carries a history keeps the no-erasure
    rule." The merge hard-deleted from `intel.case_subjects`, which is not a
    join table. So every merge failed with "permission denied for table
    case_subjects" partway through, and rolled back. Nothing was corrupted
    and nobody could merge a duplicate. Migration 0047 granted that one
    table; migration 0048 revoked it again, which is the better fix and is
    described below.

    **It destroyed what it could not move.** A row the survivor could not
    take was deleted: an alias it already had, a case both records were
    subjects of, a finding both were linked to. The case subject was the
    worst of them, because it carried the loser's own `subject_role` and
    `relationship_to_case`. Two roles on one case is a disagreement between
    two pieces of recorded work, and the platform settled it by keeping
    whichever row the survivor happened to own, and said nothing.

    **And a reversal did not reverse it.** 0036's own comment on
    `intel.entity_merges` states the intention that was missed: "`moved`
    records exactly what was reassigned, so a reversal puts it back rather
    than guessing." What `moved` holds is counts. A count cannot be put back.
    So a reversal restored the two records, their names and the match flag,
    and left every statement, case link, relationship and finding link on the
    survivor, then reported success. Aliases were the sole exception, and
    only because the merge writes a breadcrumb into each one.

    That last one is the serious one. `information` is a hop in the chain
    this platform exists to keep intact. After a merge and a reversal,
    statements gathered against one company stayed attributed to another, on
    exactly the two records somebody had just decided were NOT the same
    thing. A finding citing that information still resolved, so it read as
    sound while pointing at the wrong company.

    **The fix, and a rejected one worth recording.** The first instinct was
    to refuse a merge that would have to destroy something. 0036's comment
    makes the right objection: two records being subjects of one case is
    evidence they are the same thing, so a merge failing there would fail
    exactly when it is most obviously correct. The better answer is to stop
    deleting, and the tables already had what that needs.
    `intel.case_subjects` is unique on `(case_id, entity_id)` and carries
    `removed_at`, `removed_by`, `removal_reason` and a restore path, so the
    loser's row is withdrawn where it stands with its role and note intact.
    `intel.finding_links` has no unique constraint at all, so nothing ever
    required its delete; its rows are simply all repointed. A colliding alias
    stays on the loser, which still exists as the pointer PRD 8.4 requires,
    so nothing is orphaned.

    Migration 0048 adds `intel.entity_merge_rows`, which records every row a
    merge repointed or withdrew by identity and column. The reversal walks it
    and marks each entry restored rather than erasing it. Table and column
    names come from that table's CHECK constraints and are matched against
    literals in the reversal, never interpolated as identifiers.

    **Why the tests did not catch any of it.** The integration test was
    called "merges reversibly, moving what it says it moved and deleting no
    record" and checked none of those things after a reversal: it asserted
    the loser's status, the reopened flag and the removal of the former-name
    alias, all of which the reversal could already restore, and stopped. It
    passed throughout. The three application-level checks passed too, so no
    amount of reading the permission model would have shown the grant gap;
    the refusal came from Postgres six tables into the operation and the
    screen said "Something went wrong saving that." It was found by reading
    the web server's own stderr, which is now the second time in this build
    that was the only thing that would do it.

    The test now asserts the round trip: that the withdrawn subject keeps its
    role and comes back, that a statement moves to the survivor and returns
    to the loser, and that the move log ends fully restored.

78. **A merge never closed the match flag that authorised it.** The flag's
    statuses were open, same_entity, different_entities and undecided.
    Nothing said "decided the same thing, and merged", so a merge left the
    flag reading `same_entity` for ever.

    The screen therefore kept offering "Merge ENT-NNNN into this record" for
    a pair it had already merged, which `assertMergeable` can only refuse,
    because a merged record is no longer a record but a pointer. Nothing
    recorded whether a decision had been carried out either: two flags both
    reading `same_entity`, one merged and one not, were indistinguishable
    without going to `intel.entity_merges` to look, which is the sort of
    question a register should answer about itself.

    The reversal already assumed the missing state existed. It sets the flag
    to `undecided` so that "the decision has to be made again rather than
    silently standing", which only makes sense as the undoing of a closure.
    It was reopening a flag that had never been closed.

    Migration 0049 adds `merged`, sets it in the merge, and backfills from
    `intel.entity_merges` rather than guessing: a flag is `merged` exactly
    when a merge of that pair exists and has not been reversed. The UI needed
    no change, because `MatchDecisionForm` already returns null for any status
    other than `same_entity`, so closing the flag closes the control.

79. **A rate-limited token refresh was read as "not signed in".** The
    classifier added in entry 70 treated every 4xx as final, and 429 is a
    4xx. `getUser` refreshes an expired access token on the way through,
    Supabase rate-limits refreshes, and this project's auth limits are shared
    with the live primaddc.com website, so a burst from either app can
    produce one. "Too many requests" means ask again shortly; reading it as
    "not signed in" signs out a valid session, and because the proxy then
    clears the cookie the person re-types their password and their
    authenticator code for nothing.

    It presented as a test fixture landing on the sign-in page one minute
    after a successful sign-in, with sessions that were provably still good
    when tried by hand a moment later. 429 and 408 are now retryable, and the
    retry waits 300ms first, because an immediate second call gets the same
    answer from a rate limiter.

80. **Three defects in the end-to-end journeys themselves, which produced
    failures that looked exactly like product bugs.** Worth recording
    together, because each one wasted more time than the product bug it was
    hiding, and all three have the same shape: the test observed a state the
    product was not in.

    **A stamp shared across retries.** `const stamp = Date.now()` at module
    scope is computed once per worker, so a retry reused it and searched a
    name space it shared with the attempt that had just failed. The register
    then held two companies with the same name, `/entities?search=<stamp>`
    returned both, and the journey picked whichever sorted first, carrying
    the dead attempt's half-finished flag and merge state. The stamp is now
    derived per attempt from `testInfo.retry`.

    **Navigating straight after a submit.** The action is still in flight;
    `goto` renders the page again immediately, and because the transaction
    has not committed the fresh HTML describes the state BEFORE the write.
    Nothing re-renders after the commit, so the stale page stands for the
    whole assertion window. The write has genuinely happened and the database
    is right, which is what makes it so misleading: the failure reports a page
    that cannot be reproduced a minute later. Seven instances of this were
    found in the reporting journey and one in the intel journey, all written
    the same day; every older step waits for its success message first, which
    is why none of them had this problem.

    **And the repair for it was wrong in the same way.** Waiting for the
    control to GO looks correct and is not: `router.refresh()` replaces a
    streamed panel with its skeleton on the way, so the count passes through
    zero while the data is still in flight, the wait is satisfied by a blank,
    and the navigation races the commit exactly as before.

    The rule that falls out of it, now written into `submitAndSettle` and the
    journey: **wait for the state the action produces, not for the absence of
    the state it replaces.** A positive signal cannot be faked by a blank;
    every "it has gone" check can. Migration 0049's `Merged` badge is what
    made a positive wait available here, so the two fixes turned out to need
    each other.

---

## Performance, measured

The application is latency-bound on a database in another region, and the
numbers below are from this machine with a measured 127ms round trip to the
Supabase pooler. They are recorded because two plausible optimisations were
tried and one of them was wrong.

| Page | Time |
| --- | --- |
| Case register | 3.4s |
| Case file, any tab | 5.2s to 7.5s |
| Task register | 3.5s |

**Re-measured in M5, and the biggest win so far had nothing to do with SQL.**
By the end of M5 the case file was taking 13.8s a tab, which was not the
database: Next was prefetching every link on the page, so one page view
rendered the fourteen registers in the sidebar, the case file nine more times
(once per tab link) and one detail page per table row. With prefetching made
opt-in the same page loaded in **3.3s**. The measurement is in bug 66, and the
reason it is recorded here as well is that it reverses the usual assumption:
the fix for a slow page was not a faster query, it was not asking for
thirty-odd pages nobody had opened.

| Page, after M5 | Before | After |
| --- | --- | --- |
| Case file, subjects tab | 13.8s | 3.3s |
| Subject registration (action) | hung past 150s, half the time | 7.8s to 8.0s |
| Source recording (action) | hung past 60s, one in three | 4.4s to 4.5s |

**Where it goes.** One case page load issues 79 statements, of which 54 are
the BEGIN, `set_config` and COMMIT around each read: a repository call opens
its own transaction, and the page makes eighteen of them. The GUCs that
row-level security and the audit triggers read are transaction-local, which is
what makes the transaction necessary rather than incidental.

**What was tried and kept.** The connection pool was five, so those eighteen
transactions queued in waves. Ten is measurably better (7.5s to 5.6s) and
twenty barely better than ten, so ten is the default. The pool is deliberately
not larger: the project's 200 client connections are shared with the live
website. Reference data read by several sections of one page (the staff
directory, the classification levels) is memoised per request, and the actor
settings are published once per transaction rather than once per repository
call.

**What was tried and reverted.** Batching a page's reads into one transaction
is the obvious saving, and on trivial queries it is a real one: ten
`select count(*)`s took 2843ms as ten transactions and 633ms inside one,
because postgres.js pipelines concurrent queries down a single connection. On
the real queries it was twice as slow: the case page went from 6.9s to 18.4s
before the `set_config` fix and 12.6s after, and the register from 3.4s to
12.6s. One transaction is one connection, so the queries run one at a time,
and what dominates these is their execution rather than the round trip. The
pool runs them side by side instead. The finding is recorded in
`src/features/cases/queries.ts` so nobody repeats the experiment.

**What would actually fix it.** Deploying the application in the database's
region. At single-digit milliseconds per round trip the same 79 statements
cost about a quarter of a second, which is inside the PRD 21 budget. This is
a hosting decision rather than a code one, and it belongs with the move to
Pro that the evidence store needs anyway.

---

## Outstanding and known limitations

- **Three seeded permissions exceed PRD 16's default matrix, and this is for
  PDDC to decide rather than for me to change.** `cases:delete`,
  `clients:delete` and `engagements:delete` are granted to the Operations
  Manager. PRD 16 uses X, its soft-delete letter, in exactly one cell of the
  whole matrix, "Users and roles" for CEO/Admin, and gives the Operations
  Manager `V C E A` on both of those rows. So the seed is wider than the
  document's stated default.

  It is not obviously wrong, which is why it is here rather than fixed: an
  Operations Manager who creates a client can plausibly be the person who
  removes one created in error, every deletion is soft, reversible from the
  recycle bin and audited, and PRD 16 itself says the matrix is "the default
  starting set" that an administrator may change. But the seed IS the default
  starting set, so it should match the document, and narrowing a live
  permission is a decision with a visible consequence for whoever currently
  relies on it.

  My recommendation: narrow all three to the administrator, matching PRD 16,
  and let PDDC widen them through the Permission Builder if they want to. The
  change is one migration and no application code.

  Everything else checks out. `tests/integration/permission-catalogue.test.ts`
  now compares every gate in the source against the catalogue in both
  directions, so the `reports:export` class of defect, a feature gated on a
  permission nobody can hold, cannot be reintroduced silently. Twelve further
  gates name no catalogue row and are correct that way: PRD 16 gives those
  actions to the Administrator alone, the wildcard covers them, and each is
  listed in that test with the sentence of the PRD that makes it so.

- **Audit append-only is not absolute.** `postgres` owns the tables and can
  disable the guard triggers. Delivered position: tamper-proof for every
  application role, tamper-evident against the platform administrator via hash
  chaining plus off-system anchors. Needs a PRD amendment and written
  acceptance. See `docs/architecture.md` section 4.
- **Chain anchoring is not yet scheduled.** `audit.chain_anchors` exists and
  `verify_chain` runs on the audit screen, but publishing the signed head to
  storage outside the project needs `pg_cron` (M7).
- **A missed check-in does not alert anybody yet.** PRD 5.8 asks for an
  immediate alert to the supervisor and the Operations Manager. The data it
  has to be computed from is in place: every check-in carries the moment the
  next one falls due, and the overdue scan is a query rather than a
  reconstruction. Raising the alert needs the scheduler, which is M7. Until
  then the screens say plainly that recording something is not the same as
  raising the alarm, and the case page shows an overdue check-in to anybody
  looking at it.
- **Closure and lessons learned are M6, not M3.** `assessClosureReadiness`
  implements PRD 5.9's nine requirements and is unit tested, but three of them
  (report approved, evidence accounted for, delivery recorded) can only be
  answered by modules that do not exist yet, so the closure screen waits for
  them rather than asking somebody to attest to them by hand.
- **`pg_cron` and `pg_net` are not enabled**, so the outbox, overdue scans and
  integrity re-checks are not running yet (M7).
- **Conflict screening now searches the subject register as well** (migrations
  0038 and 0039, done in M5 as the M3 note said it would be). A check reads
  `crm.clients`, `intel.entities` and the entity aliases, keeps one row per
  record however many of its names match, and skips a merged record because
  its survivor is searched instead. Every row still names the table it came
  from, so a check run before the register existed stays readable with the
  scope it had. What PRD 8.3 still lists and the platform does not yet search
  is directors, shareholders and beneficial owners **as roles**: those are
  `intel.relationships` rows rather than records of their own, so screening
  them means deciding whether "a director of a conflicted company" is itself a
  conflict. That is a question for PDDC, not a missing join.
- **SSO needs a change in the website.** `prima-website-2.0` must pass the same
  `cookieOptions.domain` as `src/lib/supabase/cookie-options.ts`. Until then
  employees share one set of credentials but sign in twice.
- **Supabase plan.** The free tier caps objects at 50 MB and has no
  point-in-time recovery. Pro is recommended before any pilot with real case
  data.
- **Does PRD 6.4 restrict a human source's identity, or the whole record?**
  The platform restricts the identity and leaves the record at the
  classification whoever recorded it chose, because the alternative makes the
  feature impossible: no role PRD 16 gives `sources:create` to has a ceiling
  reaching STRICTLY_RESTRICTED, so raising the record meant the investigator
  who recruited the source could neither record nor read it. Migration 0043
  has the full reasoning. If PDDC want the record restricted as well, it is
  one line there plus a ceiling in the role catalogue, and they should know it
  means the case team cannot read what the source told them.
- **Credentials pasted into chat** (service-role key, database password) should
  be rotated.
- **End-to-end fixtures are real accounts** in the shared project, named
  `pddc-e2e-*@example.invalid`. Remove them with
  `E2E_ALLOW_SEED=1 npm run seed:e2e -- clean` when they are no longer needed.
