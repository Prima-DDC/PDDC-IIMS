# The acceptance demonstration

PRD 20.1 asks for one thing to be shown end to end: **Client: ABC Insurance
Ltd, Case: Corporate Fraud Investigation**, through twenty-six steps, without
breaking any record relationship. This is that walkthrough, with what to
click and what to look at, in order.

It is written to be followed by somebody who has not built the platform, so
each step says what it proves as well as what to do. Where a step is the only
place a rule can be seen working, that is called out: those are the ones worth
slowing down for.

## Before you start

```bash
DEMO_ALLOW_SEED=1 npm run seed:demo
npm run dev
```

The seed plants four records and **does not create the case**. Creating it is
step 4, and a seed that had already done the demonstration would prove
nothing. What it plants is what the walkthrough cannot produce for itself:

| Record | Why it is there |
| --- | --- |
| ABC Holdings Ghana Limited (client, dormant) | PRD 20.2 requires `ABC Holdings Ltd / ABC Holdings Ghana Limited` to be flagged. A screening run against an empty register correctly finds nothing. |
| ABC Insurance Brokers Ltd (client, dormant) | A second, closer match, so step 3 shows a list and a real decision rather than a formality. |
| John K. Mensah (subject, aliases `John Mensah` and `J. K. Mensah`) | PRD 20.2's other required pair. |
| Kwabena Mensah (subject) | Deliberately a weak match. A screen that flagged every surname equally would be useless. |

Measured against the live project after seeding:

```
ABC Insurance Ltd  -> ABC Insurance Brokers Ltd    0.64
ABC Holdings Ltd   -> ABC Holdings Ghana Limited   0.40
John Mensah        -> John K. Mensah               1.00  (via its alias)
                   -> Kwabena Mensah               0.35  (similar spelling)
Kofi Asante        -> nothing
```

You need **four accounts** signed in, because six of the steps exist only to
prove that one person cannot do all of it: an administrator, an operations
manager, an investigator and a QA reviewer. Separate browser profiles or
windows, not tabs, since they share cookies otherwise.

Afterwards:

```bash
DEMO_ALLOW_SEED=1 npm run seed:demo -- clean
```

which soft-deletes the four fixtures. They go to the recycle bin rather than
away, which is what every other deletion here does.

---

## 1. Create the client, and its KYC

**As the operations manager.** Clients, then *Add a client*.

- Organisation name `ABC Insurance Ltd`, type Corporate, classification
  CONFIDENTIAL.
- Save. Note the identifier it is given: `CLI-YYYY-NNNNNN`.
- On the client, open KYC and record a check: identity verified, with a date
  and the document seen.

**What this proves.** The identifier comes from a transactional sequence, so a
retried submission cannot skip or duplicate a number (PRD 21.7). The form also
carries an idempotency key: submit it twice from the same page and the second
submission returns the first one's answer rather than a second client.

## 2. Create the engagement

**As the operations manager.** On the client, Engagements, then *New
engagement*.

- Title `Corporate fraud investigation`, type Fraud investigation.
- Save as a draft, then submit it for approval, then approve it.

**What this proves.** PRD 4.1 puts engagement approval before case creation,
and step 4 will refuse to open a case against an engagement that is not
approved. Try it the wrong way round first if you want to see the refusal.

## 3. Run the conflict check, and have a manager decide it

**As the investigator** (running a check needs `conflicts:view`, which the
investigator has; deciding one needs `conflicts:approve`, which they do not).

- Intake, Conflict checks, *Run a check*.
- Screen three names: `ABC Insurance Ltd`, `ABC Holdings Ltd` and
  `John Mensah`.
- You should see the four matches in the table above, each with its score and
  the reason it matched.
- Try to decide the check. **You cannot**, and the screen says why.

**As the operations manager**, open the same check and decide it: *Further
review required* for the Holdings match, with a reason, then *Cleared*.

**What this proves.** PRD 20.2's two required pairs are flagged and neither is
auto-merged: a human decides, once, and the decision cannot be changed
afterwards (a mistaken decision is corrected by raising a new check, which the
screen explains). It is also the clearest place to see that the platform
distinguishes running a check from deciding one.

## 4. Create the case and define its objective

**As the operations manager.** Cases, *Open a case*.

- Against the client and engagement from steps 1 and 2.
- Title `Corporate fraud investigation`, type Fraud investigation, priority
  High, classification CONFIDENTIAL.
- On the case, record the objective and the scope.

**What this proves.** The case cannot leave its first lifecycle stage without
an objective or a recorded override (PRD 5.2). Try moving the stage before you
record one.

## 5. Add the subjects

**As the investigator.** On the case, Subjects, *Add a subject*.

- `Kofi Mensah`, a person, relationship to case: suspect.
- Watch for the duplicate flag: the register already holds John K. Mensah, and
  this is where PRD 8.4's match flagging shows itself.

## 6. Add the related company and the relationship

Still on Subjects.

- Add `ABC Procurement Services Ltd`, a company.
- Then a relationship: Kofi Mensah is a **Director of** ABC Procurement
  Services Ltd, with a source note.

**What this proves.** The relationship is a record with its own confidence and
source, not a free-text note, which is what makes the link analysis on the
Subjects tab mean something.

## 7. Create the investigation plan

**As the investigator.** On the case, Plan, *Start a plan*.

- Objective, methodology, sources to consult, deliverables.
- Submit it for approval. **It is now not yours to approve.**

**As the operations manager** (or a supervisor), approve it.

**What this proves.** PRD 9.3: an author cannot approve their own plan, and
the refusal names the rule rather than failing silently.

## 8. Assign the investigator

**As the operations manager.** On the case, assign the investigator as Lead
investigator, with a reason.

**What this proves.** Two things. Assignment is what grants access: before
this step the investigator cannot open the case at all, and the direct URL
returns 404 rather than 403, because the existence of a case they are not on
is not information they need (PRD 20.2). And the assignee is notified: check
the bell, and the notification names the case reference and nothing else.

## 9. Create the tasks

**As the operations manager or the investigator.** On the case, Tasks.

- `Interview the finance director`, due in three days.
- `Obtain the purchase order file`, due in five days.
- `Analyse the payment runs`, as a sub-task of the second.

**What this proves.** Each task notifies its assignee as it is created, in the
same transaction as the task itself, so a task that failed to save announces
nothing (PRD 12.2).

## 10. Record the activities

**As the investigator.** On the case, Activity.

- Record an interview, with the date, who was present and what was covered.
- Record a site visit.

**What this proves.** The activity log is append-only. There is no edit and no
delete, by design (PRD 9.4): a correction is a new entry that references the
one it corrects, and the screen offers exactly that.

## 11. Register the sources

**As the investigator.** On the case, Sources, *Add a source*.

- A Corporate Filing from the registrar, reliability B.
- A Human Source, reliability C, with the identity restricted.

**What this proves.** PRD 6.4: the human source's identity is held at a
restriction the case team cannot read, while the record of what it said stays
readable by them. Sign in as somebody else on the case and look at it.

## 12. Record the information, with its credibility

**As the investigator.** On the case, Information, *Add information*.

- From the corporate filing: `ABC Procurement Services Ltd was incorporated
  three weeks before the first payment run`, credibility 2, confidence
  Moderate.
- From the human source: `Payments were authorised without a purchase order`,
  credibility 3.
- Corroborate the second with the first.

**What this proves.** Source reliability and information credibility are
separate scales shown side by side, never merged into one number (PRD 6.4),
and corroboration is a link rather than an assertion.

## 13. Upload the evidence, with its hash

**As the investigator.** On the case, Evidence, *Register an item*.

- Describe it, record where and how it was collected, classification
  CONFIDENTIAL.
- Then attach a file. Any PDF will do.
- Note the status: **hash unverified**. The browser computed a hash; nobody
  has checked it.
- Press *Verify*. The server reads the object back out of storage and computes
  its own. **This takes up to two minutes against this project**, measured at
  about 108 seconds, so leave it and reload.
- The seal turns to **Verified**, with both hashes shown.

**What this proves.** The most important integrity claim in the platform. A
client-computed hash is unattestable, because whoever uploaded the file also
computed the number meant to prove it. Try it the other way: upload a file,
replace the object in the bucket, and verify again. The item goes to
**mismatch** permanently, and nothing in the application can edit that back.

Worth trying as well: rename an executable to `.pdf` and upload it. The
allow-list accepts it, because the browser reports `application/pdf` and the
extension agrees; verification refuses it on its first two bytes and records a
mismatch (PRD 14).

## 14. Show the chain of custody

On the evidence item, Custody.

- Record a transfer: released by the investigator, received by the forensics
  analyst, with the purpose.
- Press *Verify the chain*.

**What this proves.** Each custody event stores the hash of the one before it,
so the ledger is a chain and not a list. The verify button walks it. No role
in the platform can update or delete an event: the application has no
privilege to, the policy has no rule for it, and a trigger refuses it. A
correction is a new event.

## 15. Upload the documents, with versions

**As the investigator.** On the case, Documents.

- Create `Interview note: finance director`, upload version 1.
- Upload version 2 with a change note.
- Have the supervisor approve v2.
- Try to upload a v3 over the approved version.

**What this proves.** An approved version locks. The next change is v3 as a
new version, never an edit of v2 (PRD 7.3), and the folder structure was
created from the configured template when the case was opened.

## 16. Create the finding

**As the investigator.** On the case, Findings, *Add a finding*.

- Statement: `ABC Procurement Services Ltd was incorporated three weeks before
  it received its first payment, and the payments were authorised without a
  purchase order.`
- Confidence Moderate.

## 17. Link the finding to its evidence

On the finding, link the information from step 12 and the evidence from step
13.

**What this proves.** The traceability strip. The finding now shows
Source → Information → Evidence → Finding, each hop clickable, which is PRD
20.2's "every finding resolves to its evidence and sources in one click".
Submit the finding for review without a link first, and it is refused with the
reason.

## 18. Draft the report

**As the investigator.** On the case, Reports, *New report*.

- Type Investigation report.
- Add sections: executive summary, scope, methodology, findings, conclusion.
- In the findings section, cite the finding from step 16.
- Leave one factual section citing nothing, and try to submit it.

**What this proves.** PRD 10.2: a factual section that cites nothing is
refused by the server, with the section named. Not warned about: refused.

## 19. Supervisor review

Cite the section properly, then submit the report for review.

**As the investigator you cannot review it.** Open it as the supervisor and
return it with a note.

**What this proves.** PRD 10.1's no-self-approval rule applies at every stage,
not only at the final gate. The author is notified that it came back, with the
note.

## 20. QA review: one return, then approve

Correct the report as the investigator, resubmit, and move it to QA.

**As the QA reviewer**, open the QA review.

- Work through PRD 10.3's twelve checks.
- Fail one, with a comment. **The only button left is "return for
  correction"**: the result is computed from the answers, never typed.
- Return it. Correct it as the investigator. Resubmit to QA.
- Pass all twelve and approve.

**What this proves.** A failed check cannot be approved around, and an
unanswered check blocks completion: an unanswered check is one nobody looked
at. Try leaving one blank.

## 21. Approve the final report

**As the administrator or CEO**, approve the report as final.

**What this proves.** The version locks on approval, and the lock is the thing
that makes a delivered report a fixed document. The version label is shown
everywhere it is cited from now on.

## 22. Record the delivery

On the report, record delivery to the client: the date, the method, who
received it.

**What this proves.** Delivery is offered only once a version is approved.
Before that the control is absent, because there is nothing it would be honest
to deliver.

## 23. Close the case, with lessons learned

**As the investigator**, propose closure on the case's Closure tab.

- The gate shows PRD 5.9's nine requirements. Three of them are **computed**
  rather than ticked: whether a report was approved, whether evidence is
  accounted for, and whether tasks are closed. You cannot tick those.
- Record the lessons learned.
- Propose it.

**As the operations manager**, approve the closure.

**What this proves.** Nobody can attest to something the records contradict,
and the person who proposed a closure cannot approve it.

## 24. Archive the case

**As the administrator**, archive the closed case.

## 25. Search for the archived case

Press **Ctrl+K**, or go to Search.

- Search the client's name. The archived case is found, and so are its
  subjects, evidence and report.
- Search as the investigator who was never assigned: they find nothing, and
  the screen says that absence and refusal look the same from there
  deliberately.

**What this proves.** PRD 21.5: the permission filter is inside the query, so
search cannot be a way around row-level security.

## 26. Review the audit trail

**As the administrator**, Administration, Audit trail.

- Filter by the case. Every step above is there, in order, with who did it,
  when, from where, and the before and after values.
- Find the conflict decision from step 3, the plan approval from step 7, the
  evidence verification from step 13 and the report approval from step 21.
- Press *Verify the chain*.

**What this proves.** Each row holds the hash of the one before it, so the
trail is a chain. Viewing it is itself recorded, which you can see by
reloading. And the honest limit, which PDDC should hear said out loud: this is
tamper-**evident** against somebody with the database owner's credentials, not
tamper-proof, because that role can drop a trigger. `docs/architecture.md`
section 4 sets out what is and is not achievable on hosted Supabase and what
is done about it.

---

## What this demonstration does not cover

Said plainly, because a walkthrough that implied completeness would be worse
than one that did not:

- **Email.** The notifications are written and queued in the same transaction
  as the work, and you can see the queue fill. Nothing sends them until
  `SMTP_PASSWORD` is set and the schedule is registered, which is a deployment
  step. In-app notification is fully working.
- **The scheduled scans.** Overdue tasks, approaching deadlines and missed
  safety check-ins are found by a scan that runs on a schedule. The scan is
  verified and callable; registering `cron.schedule` needs the deployed URL.
- **AI.** Off, with an empty provider allow-list, which is PRD 22's own
  default. `/admin/ai` shows what enabling it would require.
- **Point-in-time recovery.** A Pro feature. `docs/runbook-backup-restore.md`
  has the restore procedure and what the free tier does and does not give you.
