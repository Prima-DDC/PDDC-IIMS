# Backup and restore

PRD 14 asks for daily incremental and weekly full encrypted backups,
point-in-time recovery, an off-system copy, quarterly restore tests, and
targets of RPO 15 minutes and RTO 4 hours. This is what the platform has
today, what it does not, and the procedures for both.

The honest summary first, because the gap matters more than the procedure:
**on the Supabase free tier, PRD 14's RPO of 15 minutes cannot be met, and
evidence files are not in the database backup at all.** Both are platform
facts rather than configuration mistakes, and both are fixed by the same
decision. That decision is set out in "What PDDC has to decide" at the end.

---

## 1. What is being protected, and what each thing needs

Four separate kinds of data, and they fail differently. Treating them as one
"backup" is the mistake this section exists to prevent.

| What | Where it lives | What loses it | Covered by |
| --- | --- | --- | --- |
| The database | Postgres, ten IIMS schemas | A bad migration, a mistaken purge, a platform failure | Supabase's own backups |
| Evidence and document FILES | Supabase Storage buckets | A deleted object, a bucket misconfiguration, a platform failure | **Nothing, until the job in section 5 is scheduled** |
| The audit trail's integrity | `audit.audit_log`, hash-chained | Nothing recovers a broken chain; the point is to detect it | Chain anchors, section 6 |
| Identities | `auth.users`, shared with primaddc.com | The same failures as the database | Supabase's own backups |

**The two that are most often got wrong.** Storage objects are not included in
a Postgres backup: restoring the database gives you every evidence RECORD with
its hash, its custody chain and its classification, pointing at files that are
no longer there. And the audit chain is not something a restore repairs: a
restore brings back a consistent chain as of the backup, and any tampering
after that point is detectable only against an anchor published outside the
project.

---

## 2. What the current plan gives you

Verified against the project, not assumed:

| | Free tier (today) | Pro |
| --- | --- | --- |
| Daily backup | Yes, retained 7 days | Yes, retained 7 days |
| Point-in-time recovery | **No** | Yes, to any second within the window |
| Best achievable RPO | **24 hours** | Minutes |
| Storage object backup | No | No, for either plan |
| Single object limit | 50 MB | 50 GB |

So the RPO today is a day, not fifteen minutes, and the first thing a restore
test will show is how much work a day is. PRD 14's target needs Pro. This is
not a criticism of the free tier: it is the tier's documented behaviour, and
building the platform on it was the right call for the build. It is the wrong
call for live case data, which is the recommendation in section 7.

---

## 3. Restoring the database

### 3.1 Before you touch anything

**The database is shared with the live primaddc.com website.** A restore of
this project restores the website's `public` schema along with the IIMS
schemas, to the same moment. That is the single most important fact in this
document. A recovery that fixes an IIMS mistake by rolling the whole project
back will also roll back every CMS edit, enquiry and ops document the website
recorded in the meantime.

So the order of preference for any IIMS problem is:

1. **Undo it in the application.** Almost everything here is a soft delete
   with a recycle bin (screen 29), and almost every mistake is recoverable
   there by an administrator, with no downtime and nothing else affected.
2. **Undo it with a migration.** A bad migration is corrected by the next
   migration. The runner tracks `config._migrations` so a corrective
   migration is an ordinary forward step.
3. **Restore a single table from a backup into a staging table**, and copy the
   rows that are needed. Section 3.3.
4. **Restore the whole project.** Only for a platform-level loss, and only
   after telling whoever owns primaddc.com.

### 3.2 Restoring the whole project

1. Tell the primaddc.com owner. Agree the target time and that the website
   will lose anything after it.
2. Supabase dashboard, Database, Backups. Choose the backup and restore it.
3. Wait. The project is unavailable during a restore.
4. Afterwards, in this order:
   - `npm run check:coexistence`, which asserts the website's own schema was
     not disturbed and that `iims_app` has no privileges outside the ten IIMS
     schemas.
   - `npm run verify:audit-chain`, which walks the hash chain and reports
     whether it is unbroken as restored.
   - Compare the restored chain head against the last published anchor
     (section 6). A mismatch means the restored state is not the state that
     was anchored, which is information rather than a failure: it tells you
     how far back the restore went.
   - Sign in. Confirm an evidence item, a report and the audit trail.
5. Then section 4: the files.

### 3.3 Restoring one table without restoring the project

The usual real case: somebody purged something they should not have, and it is
past the recycle bin.

1. Download the backup from the dashboard.
2. Restore it into a scratch database, locally or in a second Supabase
   project. Never into the live one.
3. Copy the rows out with `pg_dump --data-only --table=...` and load them into
   the live project under a staging name, for example
   `casework.cases_restored`.
4. Compare, then insert the rows that are needed.
5. Delete the staging table.

**The two things to be careful of.** `audit.audit_log` cannot be inserted into
out of order without breaking the chain, so audit rows are never restored this
way: a gap in the trail is recorded as a gap, which is the truthful outcome.
And `evidence.custody_events` is the same. If either is genuinely lost, say so
in writing rather than reconstructing it; a reconstructed custody chain is
worse than an acknowledged gap, because it looks like a record.

---

## 4. Restoring evidence and document files

**There is nothing to restore from until the job in section 5 is scheduled.**
Said first because it is the gap that matters most: an evidence record whose
file is gone is a record of something nobody can produce.

Once the job is running, the procedure is:

1. Find what is missing. Every evidence item holds its bucket, its path and
   its declared SHA-256, so the manifest is the database:

   ```sql
   select e.evidence_id, e.storage_bucket, e.storage_path, e.declared_sha256
   from evidence.evidence_items e
   where e.storage_path is not null and e.deleted_at is null;
   ```

2. Copy the objects back from the off-system copy to the same bucket and path.
3. Re-verify every restored item, which is the only acceptable proof that the
   right bytes came back: the server recomputes the SHA-256 and compares it
   with the one recorded when the item was collected. A restored object that
   does not match goes to `mismatch` and cannot be cited in a report.

That last step is why the hash matters more than the backup. A restored file
is not evidence because it was restored; it is evidence because it still
hashes to what was recorded at collection.

---

## 5. The off-system object backup, which is not yet scheduled

Storage objects need their own job because no database backup includes them.
What it has to do:

- List every object in `evidence-originals`, `evidence-copies` and
  `documents`.
- Copy anything new or changed to a destination **outside this Supabase
  project**: Cloudflare R2, Backblaze B2 or an S3 bucket. Outside, because a
  copy in the same project is lost by the same failure.
- Encrypt in transit and at rest, which all three destinations do by
  configuration.
- Write a manifest of object path and size, so a restore can tell the
  difference between "not backed up" and "backed up and missing".

**Not built, deliberately, because it needs a decision first.** The
destination, the retention and who holds its credentials are PDDC's to choose,
and a job written against a guess would have to be rewritten. What is in place
is everything it needs: the bucket names, the manifest query above, and a
`FileScannerPort`-shaped seam for anything that has to run over the objects.

Until then, the honest position is that **evidence files have no backup**, and
that is worth stating to PDDC in writing rather than leaving in a runbook.

---

## 6. Anchoring the audit chain

The audit trail is hash-chained: each row stores the hash of the one before
it, so any alteration breaks every row after it. `npm run verify:audit-chain`
walks it.

Chaining alone does not help against somebody who can rewrite the whole
chain, which the database owner can. What makes that detectable is publishing
the chain head somewhere outside the project on a schedule, so a rewritten
chain disagrees with a record nobody inside the project can reach.
`audit.chain_anchors` exists for this and `audit.verify_chain` is wired to the
audit screen. **Publishing the head off-system is not yet scheduled**, for the
same reason as section 5: it needs a destination.

See `docs/architecture.md` section 4 for what this does and does not achieve,
which PDDC has to accept in writing because it is a softening of PRD 13's
wording.

---

## 7. The quarterly restore test

PRD 14 asks for one, and a backup nobody has restored is a hope rather than a
backup. Four times a year:

1. Restore the most recent backup into a scratch project, never the live one.
2. Run `npm run verify:audit-chain` against it.
3. Sign in and confirm: a user, a case, a document version, an evidence item
   with its hash, and the audit trail.
4. Restore ten evidence objects from the off-system copy and re-verify them.
5. **Record how long it took.** That number is the real RTO, and PRD 14's
   four-hour target is a claim until somebody has measured it.
6. Write down what did not work. A restore test that finds nothing has usually
   not been thorough enough.

---

## 8. What PDDC has to decide

Three decisions, and the first one settles the other two.

1. **Move to Pro before any real case data.** It is what buys point-in-time
   recovery, which is the only way PRD 14's fifteen-minute RPO is reachable,
   and the 50 GB object limit, which decides whether video evidence can be
   stored at all. The free tier's 50 MB cap already rules out body-cam
   footage, CCTV exports and disk images (PRD 24, question 6).
2. **Where the off-system object copy goes**, and who holds its credentials.
   Section 5 is written and waiting on this.
3. **Whether the audit position in `docs/architecture.md` section 4 is
   accepted in writing.** Append-only and tamper-proof for every application
   role, tamper-evident against the platform administrator. It is the most
   that hosted Supabase allows, and it is a softening of PRD 13, so it should
   be agreed rather than assumed.
