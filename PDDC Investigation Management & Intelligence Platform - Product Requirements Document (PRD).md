&#91;image: Prima Due Diligence Consult logo\]

# PDDC Investigation Management & Intelligence Platform

**Product Requirements Document (PRD) — Version 1.0 (Phase 1A + 1B)**

Prima Due Diligence Consult (PDDC) · Product name: PDDC IIMS · Status: Draft for PDDC approval · Date: 21 October 2026

## Document Control

| Item | Detail |
| --- | --- |
| Organisation | Prima Due Diligence Consult (PDDC) |
| Product | Intelligence & Investigation Management System (IIMS) |
| Document type | Business, functional and engineering-standards requirements |
| Supersedes | PDDC IIMS PRD v1.0 and Mandatory Amendments sheet (consolidated here) |
| Database | PostgreSQL |
| Notifications | In-app + Email via Resend (API / SMTP) |
| AI | Free cloud-hosted open-source models via a provider-agnostic gateway, assistive only (see Section 22) |
| Delivery | Phase 1A (core operations) then Phase 1B (investigation intelligence) |

**Logo and brand.** The PDDC logo (shield with fingerprint, navy and green) is used on the login screen, application header, PDF report cover pages, email templates and exported documents. Source file: `prima_logo.png`; a transparent SVG version should be requested for production use.

---

## 1. Purpose of the Platform

The PDDC IIMS is the single secure operational system for PDDC's due diligence, corporate investigation and intelligence work. It manages the complete lifecycle:

**Enquiry → Client/KYC → Conflict Check → Assessment → Proposal → Engagement → Case → Subjects/Entities → Investigation Plan → Tasks → Sources → Information → Evidence → Analysis → Findings → Report → QA → Client Delivery → Closure → Archive**

**Core design principle:** capture information once, connect it to the relevant case, preserve its integrity, control access to it, keep a complete audit trail, and make every important conclusion traceable to its supporting information and evidence.

**What it must not become:** a file store, a CRM, an Excel replacement or a generic task app. The defining relationship chain is **Case → Subject → Source → Information → Evidence → Analysis → Finding → Report**.

### Product goals

1. One source of truth for every investigation.
2. Traceability from every conclusion back to evidence.
3. Evidence integrity and chain of custody.
4. Role- and classification-based access control.
5. Management visibility (workload, risk, turnaround, bottlenecks).
6. Scalability across countries, offices and service lines.

### Success criterion

PDDC can run an investigation from first enquiry to archived final report with no parallel, uncontrolled manual process.

---

## 2. Business Problems It Solves

| Problem today | Consequence | How the platform solves it |
| --- | --- | --- |
| Cases tracked in Excel, WhatsApp and personal folders | No single truth, lost context, key-person risk | Case-centric record with every artefact linked to a Case ID |
| Uncontrolled email attachments and cloud folders | Leakage, version confusion, no audit | Controlled document store, versioning, access logs |
| Separate evidence registers | Weak integrity, disputable custody | Evidence register, hashing, immutable custody events |
| No conflict screening | Reputational and legal exposure | Automated fuzzy conflict detection with manager decision |
| Conclusions not traceable | Reports hard to defend or QA | Finding ↔ Evidence ↔ Information ↔ Source links |
| No management visibility | Late delivery, uneven workload | Dashboards, overdue detection, turnaround metrics |
| Scope creep unmanaged | Unbilled work | Scope change control with cost/time/approval |
| Investigator safety not recorded | Duty-of-care gap | Safety plans, check-in/out, incident reports |
| Lessons not captured | Knowledge walks out the door | Lessons Learned feeding a knowledge base |

---

## 3. Users and Roles

Access is determined by **Role + Permission + Information Classification + Case Assignment**.

**Note:** the table below lists the investigation-specific default roles. The full, configurable role catalogue, multi-role assignment and the Administration module are defined in Sections 3.1 to 3.4. Roles and permissions are **data, not code**: an administrator can add, edit and remove them without a software release.

| Role | Purpose | Key access | Explicit limits |
| --- | --- | --- | --- |
| CEO / System Administrator | Governance and administration | All authorised cases, users, roles, security settings, configuration, dashboards, audit logs (read) | Administrator role: full access and full CRUD on every record and feature; the only limit is that audit logs and custody events are append-only (Section 3.5) |
| Operations Manager | Run operations | Clients, engagements, all operational cases, assignments, workloads, deadlines, plans, conflict decisions | Not automatically cleared for STRICTLY RESTRICTED material |
| Supervisor | Lead a team's cases | Assigned team cases, plans, tasks, activities, sources, evidence, findings, drafts; approve or return work; approve closure | Cannot approve own authored work |
| Investigator | Execute investigations | Assigned cases and tasks, approved plan, sources, activities, evidence, documents, draft reports | Cannot delete evidence, edit audit history, change permissions, access unassigned cases, approve own final report |
| Intelligence Analyst | Analyse | Assigned cases, sources, information, evidence, findings, analytical products, reports | No client-financial access |
| Digital Forensics Specialist | Digital evidence | Authorised cases, digital evidence, hashes, forensic records and reports | Restricted to authorised cases |
| QA / Reviewer | Independent review | Assigned reports, supporting documentation, evidence, findings, QA checklist; approve or return | Cannot edit report content |
| Finance | Billing | Client, engagement, case billing, invoice references, payment status | No investigative evidence by default |
| Client (future, V2) | Portal | Own delivered reports and status only | Not in V1 |

### 3.1 Role Catalogue (Administrator-Configurable)

The system ships with the starter roles below. Administrators can create more, clone, rename, deactivate or delete roles at any time. **Employee** is the baseline role every user holds and cannot be removed.

| Role | Purpose | Typical scope |
| --- | --- | --- |
| Administrator | Full administration of every user, role, permission, feature, record and system setting | System-wide; full CRUD on everything (see Section 3.5) |
| CEO | Executive oversight of operations, risk, quality and performance | All dashboards and reports; case access per grant |
| COO | Day-to-day operational leadership across offices | Operations, workload, deadlines, approvals |
| Manager | General line management of a team or department | Own team, approvals, team reporting |
| Operations Manager | Case assignment, workloads, deadlines, conflict decisions | All operational cases |
| HR Manager | People records, onboarding/offboarding, training, leave | HR data only; no investigative content |
| Finance | Billing, invoices, payments, case costs | Financial data only |
| Supervisor | Lead a team's investigations; approve or return work | Assigned team cases |
| Investigator | Execute investigations | Assigned cases |
| Intelligence Analyst | Analyse sources, information and findings | Assigned cases |
| Digital Forensics Specialist | Digital evidence handling | Authorised cases |
| QA / Reviewer | Independent report review | Assigned reports |
| Compliance Officer | Conflict, legal hold, retention and policy oversight | Read access plus compliance actions |
| Legal Counsel | Legal review of reports and holds | Assigned matters |
| Records / Evidence Custodian | Custody and storage of evidence | Evidence register |
| Auditor (read-only) | Independent review of audit trail and records | Read-only, time-limited |
| *Further roles* | Added by the administrator as PDDC grows | Defined by the administrator |
| **Employee** | Baseline for all staff: own profile, notifications, company notices, own tasks and time entries | Own data only |

### 3.2 Multiple Roles per User

- A user can hold **any number of roles at once** (for example Supervisor + QA Reviewer, or Manager + HR Manager).
- **Effective permissions** = the union of all permissions from the user's active roles, plus any user-specific grants, minus any user-specific denies. An explicit **deny always overrides** an allow.
- Each role assignment can be **scoped** to everything, an office, a country, a department, a team or specific cases, and can carry **start and end dates** for temporary cover.
- A **primary role** is shown in the interface; the user sees the combined menu and features of all assigned roles.
- The user's screen lists every assigned role and the permissions each one contributes; the administrator also sees an **Effective Permissions viewer** that answers "why can or can't this user do X?" and names the role or override responsible.
- **Separation-of-duties rules** are configurable: the administrator can define incompatible role pairs or actions (for example, a user cannot approve a report they authored even if they hold both Investigator and QA roles; a user cannot hold both Finance and Administrator).
- Classification clearance (up to STRICTLY RESTRICTED) is assigned per user and is not granted by a role alone, except that the Administrator role carries every clearance level.

### 3.3 Administration Module (Admin Dashboard)

Only users holding administration permissions can open it. All screens support search, filters, bulk actions and export, and every change is audited.

**User management**

| Action | Behaviour |
| --- | --- |
| Add | Create a user (name, work email, phone, department, office, country, employee ID, roles, clearance) or invite by email through Resend; the invitee sets a password and enrols MFA on first login; CSV bulk import is supported |
| View | User profile with status, roles, effective permissions, feature access, clearance, assigned cases and tasks, login history, active sessions, recent activity |
| Edit | Change details, roles, scopes, clearance, office/country, department, status; bulk role assignment for selected users |
| Suspend / reactivate | Immediately blocks login and revokes sessions while keeping all data |
| Remove | Deactivate and archive (default). Open cases, tasks and custody items must be reassigned first; records keep the user's name for accountability. Permanent erasure of personal data only where law requires, and never of audit or custody records |
| Security | Reset password, reset or re-enrol MFA, unlock account, force logout, revoke sessions and trusted devices |

User lifecycle: Invited → Active → Suspended → Deactivated → Archived.

**Role management**

- Create, clone, edit, deactivate and delete roles; a role in use cannot be deleted until its users are moved to another role.
- Role definitions are **versioned** with change reason, author and a before/after comparison; roles can be rolled back.
- Each role page shows its members, permissions, features, dashboard and notification defaults.

**Permission builder**

A permission is built from four parts, all chosen by the administrator in the interface:

1. **Resource:** client, engagement, case, entity, plan, task, source, information, evidence, custody, document, finding, report, QA, financials, time, users, audit, settings and any module added later.
2. **Action:** view, create, edit, upload, download, share, approve, delete, export, assign, configure.
3. **Scope:** own records, assigned, team, department, office, country, all.
4. **Classification ceiling:** the highest classification the permission applies to.

**Feature and module access**

The administrator switches features on or off per role and per user: modules (for example Safety, Financials, Time Tracking, Knowledge Base), global search, exports and report downloads, AI assistance and its quota, dashboards and widgets, bulk upload, notification categories and API access.

**Per-role and per-user configuration**

Default landing page and navigation menu, dashboard layout and widgets, data scope (offices and countries), clearance level, session timeout, MFA method, export limits, upload limits, AI quota and notification defaults. A **user-specific override** can grant or deny any permission or feature for one user, with a mandatory reason and an optional expiry date.

### 3.4 Administration Safeguards

- **Two-person rule** for high-risk changes: granting the Administrator role, granting STRICTLY RESTRICTED clearance, granting delete or export-all permissions, changing audit or retention settings. A second administrator must approve.
- An administrator cannot raise their own privileges without second approval, and the last active administrator cannot be removed or suspended.
- Administrators **have automatic access to all case content and every feature; all of it is logged, and sensitive actions are reviewable in the audit trail**.
- Nobody, including administrators, can alter or delete audit logs or custody events.
- Permission changes take effect **immediately**: permission caches are invalidated and active sessions refresh their permissions without needing re-login.
- Every administrative action is logged with actor, target, before and after values, reason and approver; the Audit screen has an **Access Changes** view and periodic **access review reports** (who has what) that managers can certify.
- Joiner-mover-leaver support: changing a user's department prompts a role review, and removal triggers a checklist (reassign work, revoke sessions, transfer evidence custody).

### 3.5 Administrator Privileges (Full CRUD on Everything)

The **Administrator** role holds **View, Create, Edit, Upload, Download, Share, Approve, Delete, Export, Assign and Configure on every resource and every feature**, across all countries, offices, clients, cases and classification levels. Any new module, resource or feature added later automatically receives a full Administrator grant.

| Area | Administrator capability |
| --- | --- |
| Users, roles, permissions, features, overrides | Full create, read, update, delete (Section 3.3) |
| Clients, engagements, intake, conflict checks | Full CRUD, including recording conflict decisions |
| Cases, objectives, scope, risk, assignments, plans, tasks, activities, communications, safety, financials, time | Full CRUD; reassign, reopen closed cases, change status with a recorded reason |
| Entities, relationships, sources, information, findings, analysis | Full CRUD, including confirming or reversing entity merges |
| Evidence | View, upload, download, edit metadata, transfer, remove. Original files are never overwritten: edits create a new version or working copy, and removal is a recoverable soft-delete |
| Documents and reports | Full CRUD, including unlocking an approved final and issuing a new version with a reason |
| Workflows, folder templates, retention rules, legal holds, classifications, notifications, dashboards, settings, backups and restore | Full CRUD and configuration |
| Audit logs and chain-of-custody events | View, search, export and integrity verification. **Append-only for everyone, including the Administrator:** they cannot be edited or deleted; corrections are added as new entries |

**Rules that apply to this privilege**

- Every administrator action is logged with actor, record, before and after values and reason.
- **Delete is a soft-delete by default:** records move to a recycle bin where an administrator can restore them within the retention period before permanent purge.
- Permanent purge of evidence or sensitive records requires second-administrator approval and is blocked while a Legal Hold applies.
- The Administrator cannot approve a report or plan they authored themselves, and the two-person rule for high-risk changes (Section 3.4) stays in force.
- The audit log and custody events stay append-only on purpose: it is what makes them credible if evidence or reports are challenged, and it protects administrators from being blamed for changes they did not make.

---

## 4. Complete Investigation Workflow

### 4.1 Intake and onboarding

**Enquiry → Client/KYC → Conflict Check → Case Assessment → Proposal/Quotation → Engagement Approval → Case Creation.** Intake history is retained permanently.

### 4.2 Case lifecycle states

New → Pending Approval → Approved → Assigned → Investigation in Progress → Awaiting Information → Analysis → Draft Report → Quality Review → Approved → Delivered → Completed → Closed → Archived.

Every transition records user, time, reason and before/after state. Illegal transitions (for example Draft Report straight to Closed) are rejected by the server.

### 4.3 Investigation methodology (configurable)

**Planning → Collection → Verification → Analysis → Assessment → Reporting.** PDDC administrators can rename, add or reorder stages, and attach required checks to each, without code changes.

### 4.4 The six required user journeys

| Journey | Flow |
| --- | --- |
| A. New client | Create client → KYC → engagement → client activated |
| B. New case | Client → conflict check → new case → objectives → scope → risk → assignment → investigation plan |
| C. Investigation | Tasks → activities → sources → information → evidence → analysis → findings |
| D. Report | Findings → draft report → supervisor → QA → approval → final → client delivery |
| E. Evidence | Collect → register → store → transfer → review → return/archive |
| F. Closure | Objectives met → evidence accounted for → report approved → delivery → financial status → lessons learned → closure → archive |

### 4.5 Phasing

**Phase 1A — Core PDDC system** (manage a real case from intake to investigation): login and users, roles and permissions, clients, engagements, conflict checks, case creation and numbering, objectives and scope, risk assessment, investigator assignment, investigation plans, tasks and deadlines, activity logs, subjects/entities, basic documents, basic dashboard, audit trail, backup.

**Phase 1B — Investigation intelligence** (the full IIMS V1.0): sources, information records, evidence register, chain of custody, evidence classification, findings, analysis, entity relationships, report management and version control, supervisor review, QA workflow, case closure, archive, advanced search, notifications.

Notifications infrastructure (the outbox and Resend integration) is built in 1A so that assignments and deadlines work from day one; the full notification catalogue completes in 1B.

---

## 5. Case Management Module

**Case ID format:** `PDDC-YYYY-NNNNNN` (e.g. PDDC-2026-000001), generated server-side from a database sequence, never client-side.

### 5.1 Capabilities

- Create, edit, assign, prioritise and track cases.
- Define instruction, objective, questions to answer, scope, out-of-scope, deliverables and deadline. A case cannot be opened without an objective unless an authorised user records an override with reason.
- Documented risk assessment.
- Scope change control.
- Case communications log.
- Basic financials and time/resource tracking.
- Investigator safety for field work.
- Closure with lessons learned.

### 5.2 Data fields — Case

| Group | Fields |
| --- | --- |
| Identification | case\_id, title, client\_id, engagement\_id, case\_type, jurisdiction (country/region), office, priority, risk\_level, status, opened\_at, target\_completion\_at, actual\_completion\_at, classification |
| Assignment | lead\_investigator, supporting\_investigators\[\], supervisor, analyst, specialist, operations\_manager |
| Objectives | client\_instruction, objective, questions\[\], scope, out\_of\_scope, deliverables\[\], deadline |
| Closure | retention\_class, closure\_summary, closed\_by, closed\_at |

**Case types:** Due Diligence, Corporate Investigation, Insurance Investigation, Fraud Investigation, Background Investigation, Employee Screening, Asset Search, Corporate Intelligence, Digital Investigation, Surveillance, Other (administrator-configurable).

### 5.3 Risk assessment

Ratings of **Low / Medium / High / Critical** for: operational, legal/regulatory, reputational, investigator safety, information sensitivity, and an overall rating with rationale, assessor and date. Critical cases require Operations Manager approval before assignment.

### 5.4 Scope change control

Original Scope → Change Request → Reason → Approval → Revised Scope. Fields: change\_id, requested\_by, reason, additional\_cost, additional\_time, client\_approval (reference), approving\_officer, approved\_at. The original approved scope is immutable and always viewable beside revisions.

### 5.5 Case communications

Material communications only (instructions, clarifications, scope and deadline changes, approvals, decisions). Fields: date/time, sender, recipient, subject, body, attachment reference, related case/task.

### 5.6 Basic financials (not an accounting system)

Quoted fee, approved fee, currency, additional fees, invoice number, amount invoiced, amount paid, outstanding (computed), payment status, notes. Visible to Finance, Operations Manager and CEO only.

### 5.7 Time and resource tracking

Investigator hours, analyst hours, field days, surveillance hours, travel expenses, external costs, specialist costs. Enables case revenue vs cost and service profitability analysis later.

### 5.8 Investigator safety

Assignment location, site-visit risk, known hazards, safety instructions, emergency contact, required check-in schedule, check-in/check-out events, incident report. A missed check-in raises an immediate alert to the supervisor and Operations Manager.

### 5.9 Case closure

Requires: objectives addressed, tasks completed, evidence accounted for, report approved, client delivery recorded, outstanding issues documented, financial status recorded, lessons learned recorded, retention class selected. **Supervisor approves closure.** The system blocks closure while any item is incomplete.

**Lessons learned:** what worked, what did not, challenges, new sources discovered, new fraud typologies, methodological lessons, recommendations, and a flag to contribute to the PDDC training/knowledge base.

---

## 6. Evidence Management Module (Evidence and Exhibits)

**Evidence ID format:** `EV-YYYY-CCCCCC-NNN` (e.g. EV-2026-000158-001), where CCCCCC is the case number.

### 6.1 Data fields — Evidence item

| Field | Notes |
| --- | --- |
| evidence\_id, case\_id | System generated |
| exhibit\_no | Optional exhibit reference for reports |
| evidence\_type | Document, Photograph, Video, Audio, Email, CCTV, Digital file, Device, Physical item, Interview record, Public record, Registry record, Financial record, Other |
| description, source\_id | Links to source register |
| collected\_by, collected\_at, location, collection\_method | Mandatory |
| copy\_status | Original or Working copy; working copies link to their original |
| file\_name, file\_type, file\_size, sha256\_hash | Computed server-side on upload |
| storage\_location, classification, current\_custodian, status | Status e.g. Registered, In review, Released, Returned, Archived |

### 6.2 Chain of custody

Every movement creates a permanent, append-only custody event: evidence\_id, date/time, released\_by, received\_by, purpose, location, condition, confirmation/signature, server timestamp. Events cannot be edited or deleted by any role; corrections are made by adding a correcting event.

### 6.3 Digital evidence controls

- Encryption in transit and at rest.
- SHA-256 recorded at upload; integrity re-verification on demand and on a schedule, with alert on mismatch.
- Upload, view and download are all logged.
- Originals are write-protected; analysts work on working copies.
- Uploads are resumable and idempotent (same file and key never creates a duplicate record).

### 6.4 Information and source records (Phase 1B)

The system keeps the chain **Source → Information → Evidence → Finding** distinct. Source reliability and information credibility are rated **separately**:

| Source Reliability | Information Credibility |
| --- | --- |
| Reliable | Confirmed |
| Usually Reliable | Probable |
| Unknown | Possible |
| Questionable | Doubtful |
| Unreliable | Unverified |

Human-source identities carry additional access controls (STRICTLY RESTRICTED by default, named-user access only).

---

## 7. Document Management Module

### 7.1 Standard case folder structure (administrator-configurable)

01 Engagement · 02 Client Information · 03 Investigation Plan · 04 Field Investigation · 05 Interviews · 06 Corporate Records · 07 Financial Records · 08 Digital Evidence · 09 Analysis · 10 Draft Reports · 11 Final Report · 12 Closure

Created automatically when a case is created.

### 7.2 Version control

Each document keeps: version number (v0.1, v0.2, v1.0 …), author, timestamp, change note, current-version flag, approved-version flag. **Approved final documents are locked** against ordinary editing; a new version requires a recorded reason and re-approval.

### 7.3 Data fields — Document

document\_id, case\_id, folder, title, document\_type, classification, current\_version, approved\_version\_id, uploaded\_by, uploaded\_at, file\_name, mime\_type, size, sha256\_hash, related source/evidence/task, tags.

### 7.4 Classification

PUBLIC · INTERNAL · CONFIDENTIAL · RESTRICTED · STRICTLY RESTRICTED. A user must hold both the role permission and the clearance for the classification to open an item.

---

## 8. Client Management Module

**Client ID format:** `CLI-YYYY-NNNNNN` (e.g. CLI-2026-000125).

### 8.1 Data fields — Client

client\_id, organisation\_name, contact\_person, position, telephone, email, address, country, industry, client\_type, KYC\_status, client\_risk\_rating, account\_manager, date\_onboarded, active\_status.

**Client documents:** registration documents, identification, NDA, engagement letter, contract, purchase order, other.

### 8.2 Engagement layer

Structure: **Client → Engagement → Case.** One client has many engagements; one engagement has many cases.

Engagement fields: engagement\_id, client\_id, engagement\_type, start\_date, end\_date, contract/NDA reference, scope\_of\_services, commercial\_terms, responsible\_manager, status.

### 8.3 Intake and conflict-of-interest checking

Before a case becomes active the system searches all PDDC records for potential matches on client, subjects, companies, directors, shareholders, beneficial owners and related entities.

- **Fuzzy and variant matching** (e.g. "John Mensah" / "John K. Mensah"; "ABC Holdings Ltd" / "ABC Holdings Ghana Limited") using trigram similarity (PostgreSQL `pg_trgm`), phonetic keys, and normalisation of suffixes such as Ltd/Limited.
- Matches are shown as **Potential Conflict Detected** with a similarity score and the matching record. The system never concludes they are the same.
- An authorised manager records the decision: **Cleared · Further Review Required · Conflict — Declined**, with reason. The decision is immutable and audited.
- A case cannot move to Approved while a conflict check is unresolved.

### 8.4 Entity resolution

Investigators can flag **Potential Duplicate / Potential Match** between entity records. Merging requires authorised confirmation; merges are reversible through a retained merge log and never delete source records.

---

## 9. Task Management Module

### 9.1 Data fields — Task

task\_id, case\_id, title, description, assigned\_to, created\_by, priority (Low/Medium/High/Urgent), start\_date, due\_date, status, completed\_at, methodology\_stage, parent\_task\_id (optional), comments\[\], attachments\[\].

**Statuses:** Not Started, In Progress, Blocked (reason required), Completed, Cancelled (reason required).

### 9.2 Behaviour

- Overdue tasks are identified automatically by a scheduled job and flagged in the UI, dashboards and notifications.
- Tasks originate from the approved investigation plan or are added ad hoc by supervisors/investigators.
- Every task change is audited and appears in the case activity log.
- Views: List, Kanban by status, Calendar by due date; filters by case, assignee, priority, overdue.

### 9.3 Investigation plan

Fields: objective, scope, methodology, sources to be consulted, tasks, assigned personnel, timeline, risks, resources, expected deliverables. Workflow: Investigator → Supervisor review → **Approved / Returned**, with timestamped approval. Approved plans are versioned; changes require re-approval.

### 9.4 Investigation activity log

Chronological and append-only. Fields: activity\_id, case\_id, date, time, user, activity\_type, description, location, related source, related evidence, related document. Corrections are new entries referencing the original.

---

## 10. Reporting

### 10.1 Report workflow

**Draft → Investigator Review → Supervisor Review → QA Review → Approval → Final → Client Delivery.** Each stage is recorded with user, time and decision. The author can never approve their own report.

### 10.2 Report features

- Structured report builder with sections pulled from findings, so every statement can cite finding IDs and exhibit numbers.
- Version control (v0.1 … v1.0 … Approved Final); final versions are locked.
- Export to PDF with PDDC logo, classification banner and page footer; Word export for editing.
- Client delivery record: delivered\_to, method, date, version delivered, acknowledgement.

### 10.3 QA checklist

Scope addressed · instructions followed · evidence referenced · sources appropriately recorded · facts separated from analysis · contradictions addressed · dates verified · names verified · findings supported · conclusions supported · classification correct · formatting correct. The reviewer chooses **Approve** or **Return for Correction** with comments per item.

### 10.4 Management reports

Case register, turnaround time, workload by investigator, overdue tasks, QA return rate, revenue vs cost per case (from financial and time data). All exportable to CSV/PDF with permission checks applied.

---

## 11. Dashboard

| Dashboard | Widgets |
| --- | --- |
| CEO / Management | Active, completed and overdue cases; high-risk and critical cases; cases by client, investigator, type, jurisdiction/country, risk; reports awaiting approval; workload; average turnaround; backlog; bottlenecks; recent system activity |
| Operations Manager | New cases, unassigned cases, pending conflict checks, deadlines this week, workload heat-map |
| Supervisor | Team cases, plans awaiting approval, drafts awaiting review, overdue tasks, safety check-ins due |
| Investigator | My Cases, My Tasks, My Deadlines, My Activities, My Evidence, My Reports |
| QA | Reports awaiting review, returned reports, common failed checklist items |
| Finance | Invoices outstanding, payment status by engagement |

Each dashboard shows only data the viewer is authorised to see. Widgets load lazily and independently so one slow widget never blocks the page.

---

## 12. Notifications

**Channels (V1):** in-app and email through **Resend** (HTTPS API primary, SMTP fallback). Other channels (WhatsApp, SMS, Slack) are future.

### 12.1 Notification catalogue

New case assignment · new task · approaching deadline · overdue task · evidence requiring review · report requiring review · report returned · case status change · case closure · conflict potential detected · missed safety check-in · integrity check failure · security alerts.

### 12.2 Delivery architecture

- **Transactional outbox:** business actions write a notification row in the same database transaction. A worker sends from the outbox, so no email is lost or sent for a rolled-back action.
- **Idempotent sending:** each notification has a unique idempotency key, passed to Resend, so retries never duplicate emails.
- **Retries** with exponential backoff and dead-letter state; delivery status stored (queued, sent, delivered, bounced, failed) via Resend webhooks.
- **Preferences:** users choose in-app/email per category; security alerts cannot be disabled.
- **Confidentiality:** emails carry no case detail beyond Case ID and a secure link; evidence, findings and subject names are never put in email bodies.
- Sender domain is authenticated with SPF, DKIM and DMARC.
- In-app notifications update in near real time (server-sent events or WebSocket, with polling fallback).

---

## 13. Audit Trail

**Logged automatically:** login, logout, failed login, case creation/access/changes, status changes, evidence upload/access/download/transfer, document upload/download, report approval, permission changes, conflict decisions, legal hold changes, exports, case closure, configuration changes.

**Audit record:** audit\_id, user, action, timestamp (UTC), record type and ID, case\_id, IP, device/user agent, before value, after value, request correlation ID.

**Integrity requirements**

- Append-only: no UPDATE or DELETE privilege for the application database role; enforced by database permissions and triggers.
- Hash-chained entries (each row stores the hash of the previous) so tampering is detectable; periodic anchor of the chain head to off-system storage.
- The administrator can read but not alter audit logs; viewing the audit log is itself audited.
- Searchable and exportable by authorised users, filterable by user, case, action and date.

---

## 14. Security Requirements

| Area | Requirement |
| --- | --- |
| Authentication | Strong password policy, mandatory MFA (TOTP; WebAuthn passkeys preferred), session timeout, secure refresh-token rotation, login throttling, account lockout, new-device alerts |
| Authorisation | Server-side RBAC plus case-assignment and classification checks on every request; deny by default; PostgreSQL row-level security as a second line of defence |
| Permissions | View, Create, Edit, Upload, Download, Share, Approve, Delete evaluated separately |
| Encryption | TLS 1.2+ in transit; AES-256 at rest for database and file storage; field-level encryption for human-source identities and ID numbers; encrypted backups; keys in a managed KMS/secret store |
| Data separation | Country/office/jurisdiction tags on all records; per-jurisdiction access rules and data-residency options |
| Deletion | The Administrator holds delete on all records, executed as recoverable soft-delete with a reason; permanent purge of evidence or sensitive records needs second-administrator approval and is blocked under Legal Hold; retention-driven disposal requires two approvers and respects Legal Hold |
| Application | CSRF protection, input validation, output encoding, strict CSP, rate limiting, file-type and malware scanning on upload, dependency scanning |
| Idempotency and integrity | Idempotency keys on all mutating endpoints; optimistic concurrency (version columns) to prevent silent overwrites |
| Monitoring | Centralised logs, anomaly alerts (mass downloads, off-hours access), uptime monitoring |
| Backup and DR | Daily incremental and weekly full encrypted backups, point-in-time recovery for PostgreSQL, off-system copy, quarterly restore tests; target RPO 15 minutes and RTO 4 hours (to be confirmed by PDDC) |

### 14.1 Legal hold

Fields: case/record, reason, issued\_by, date\_issued, scope, expiry/release date, released\_by. A record under hold cannot be disposed of by retention rules or ordinary deletion.

### 14.2 Retention

Configurable by record type, jurisdiction, client requirement, legal requirement and PDDC policy; review alerts are generated before disposal dates.

---

## 15. Data Fields for Remaining Modules

Fields for Case, Evidence, Document, Client, Engagement and Task are in Sections 5 to 9. All tables also carry: `id` (UUID), `created_at`, `created_by`, `updated_at`, `updated_by`, `version` (for optimistic locking), `country`, `office`, `classification` where relevant, and `deleted_at` (soft delete where permitted).

| Module | Fields |
| --- | --- |
| User | user\_id, name, email, phone, role(s), office, country, clearance\_level, MFA status, status, last\_login |
| Subject / Entity | entity\_id, name, entity\_type (Person, Company, Director, Shareholder, Beneficial Owner, Employee, Organisation, Property, Vehicle, Account, Asset, Other), aliases\[\], nationality/country, registration\_no, id\_reference (encrypted), address, relationship\_to\_case, source references, resolution\_status |
| Relationship | relationship\_id, from\_entity, to\_entity, relationship\_type (Director of, Owns, Subsidiary of, Associated with …), percentage/period, source/evidence reference, confidence |
| Source | source\_id, case\_id, source\_type (Public Registry, Government Record, Interview, Human Source, Client, Open Source, Media, Database, Corporate Filing, Financial Record, Court Record, Other), description, date\_obtained, obtained\_by, source\_reliability, access\_restrictions, verification\_status |
| Information | information\_id, case\_id, source\_id, date\_obtained, description, information\_credibility, verification\_status, corroborating\_sources\[\], related\_evidence\[\], analyst, confidence (High/Moderate/Low/Unverified) |
| Finding | finding\_id (F-001), case\_id, statement, supporting\_information\[\], supporting\_evidence\[\], analyst, confidence, date, reviewer, status |
| Conflict check | check\_id, case/enquiry, matched record, similarity score, decision (Cleared / Further Review Required / Conflict — Declined), decided\_by, reason, decided\_at |
| Risk assessment | case\_id, operational, legal\_regulatory, reputational, safety, sensitivity, overall, rationale, assessed\_by |
| Report | report\_id, case\_id, title, version, status, author, reviewers, QA result, approved\_by, approved\_at, delivered\_at |
| Comment | comment\_id, parent object, author, body, mentions, created\_at |
| Tag / Location / Retention rule | Standard lookup tables with jurisdiction and record-type scope |

---

## 16. User Permissions

Legend: **V** view · **C** create · **E** edit · **U** upload · **D** download · **A** approve · **S** share · **X** delete (restricted/soft). A dash means no access. All permissions apply only to cases the user is authorised for, within their clearance.

| Resource | CEO/Admin | Ops Manager | Supervisor | Investigator | Analyst | Forensics | QA | Finance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Users and roles | V C E X | V | — | — | — | — | — | — |
| Clients and engagements | V C E | V C E A | V | V | — | — | — | V |
| Conflict decisions | V | V A | V | — | — | — | — | — |
| Cases | V | V C E A | V E A | V E (assigned) | V (assigned) | V (authorised) | V (assigned) | V (billing only) |
| Investigation plans | V | V | V A | V C E | V | — | V | — |
| Tasks and activities | V | V C E | V C E | V C E | V C E | V C E | V | — |
| Subjects/entities | V | V | V C E | V C E | V C E | V | V | — |
| Sources and information | V | V | V C E | V C E | V C E | V | V | — |
| Evidence | V | V | V U D | V C U D | V D | V C E U D | V D | — |
| Custody events | V | V | V C | V C | V C | V C | V | — |
| Documents | V | V | V C E U D | V C E U D | V C U D | V C U D | V D | Billing docs only |
| Findings | V | V | V A | V C E | V C E | V C E | V | — |
| Reports | V A | V | V A | V C E | V C E | V C E | V A | — |
| Financials and time | V | V C E | V | Own time | Own time | Own time | — | V C E |
| Audit logs | V | — | Case-level V | — | — | — | — | — |
| Dashboards | Management | Operations | Team | Personal | Personal | Personal | QA | Finance |

**Hard rules:** nobody can alter or delete audit records; evidence is never silently hard-deleted: only the Administrator can remove it, as a recoverable soft-delete with reason and second-administrator approval, never while under Legal Hold; authors cannot approve their own work; Finance sees no investigative content; STRICTLY RESTRICTED items require named-user grants for every role except Administrator, whose access is automatic and always logged.

**Configurable matrix:** the matrix above is the **default starting set**. The administrator can change any cell, add roles (Section 3.1) and add resources or features through the Permission Builder (Section 3.3). Users with several roles receive the union of their roles' permissions, with explicit denies taking priority (Section 3.2).

---

## 17. Database Structure (PostgreSQL)

### 17.1 Conventions

- PostgreSQL 16+, schema-per-domain (`iam`, `crm`, `casework`, `intel`, `evidence`, `docs`, `reporting`, `audit`, `notify`, `config`).
- UUID primary keys plus human-readable IDs generated from sequences (case, client, evidence, finding).
- All timestamps `timestamptz` in UTC. Enums for statuses, with transitions enforced in the service layer.
- Extensions: `pg_trgm` (fuzzy conflict matching), `pgcrypto` (hashing, field encryption), `citext`, `btree_gin`, `unaccent`. Optional `pgvector` for AI embeddings (future).
- Full-text search with `tsvector` and GIN indexes; permission filtering is applied in the query, never after.
- Row-level security keyed on user, assignment and clearance; audit schema is append-only.
- Binary files stay in encrypted object storage (S3-compatible); the database stores metadata, hashes and storage keys.
- Idempotency table: `idempotency_keys(key, user_id, endpoint, request_hash, response, created_at, expires_at)`.
- Transactional outbox: `notify.outbox`; same pattern reused for webhooks and AI jobs.

### 17.2 Core tables and relationships

| Schema | Tables |
| --- | --- |
| iam | users, roles, role\_versions, permissions (resource, action, scope, classification ceiling), role\_permissions, user\_roles (with scope, valid\_from, valid\_to), user\_permission\_overrides, features, role\_features, user\_features, role\_incompatibilities, access\_change\_requests, user\_invitations, departments, clearances, sessions, mfa\_devices, offices, countries |
| crm | clients, client\_contacts, client\_documents, engagements, enquiries, kyc\_records, conflict\_checks, conflict\_matches |
| casework | cases, case\_assignments, case\_objectives, risk\_assessments, scope\_versions, scope\_change\_requests, case\_communications, investigation\_plans, plan\_versions, tasks, task\_comments, activities, safety\_plans, check\_ins, incidents, case\_financials, time\_entries, expenses, closures, lessons\_learned |
| intel | entities, entity\_aliases, entity\_relationships, entity\_match\_flags, entity\_merge\_log, sources, information, findings, finding\_links (finding to information/evidence), analyses |
| evidence | evidence\_items, evidence\_files, custody\_events, integrity\_checks |
| docs | folders, documents, document\_versions, tags, document\_tags |
| reporting | reports, report\_versions, report\_sections, qa\_reviews, qa\_checklist\_items, deliveries |
| audit | audit\_log (hash-chained), access\_log |
| notify | notifications, outbox, preferences, delivery\_events |
| config | workflow\_definitions, workflow\_stages, retention\_rules, legal\_holds, classification\_levels, settings |

**Key relationships:** client 1→N engagement 1→N case; case 1→N entity, source, task, activity, evidence, document, report; source 1→N information; finding N↔N information and evidence; evidence 1→N custody\_events; document 1→N versions; case 1→N audit entries. A formal ERD is a pre-coding deliverable.

---

## 18. Screen-by-Screen Description

Every screen is case-centric, shows classification and status badges, supports keyboard navigation, and works on desktop, tablet and phone.

| # | Screen | Description and key elements |
| --- | --- | --- |
| 1 | Login and MFA | PDDC logo, email/password, MFA step, lockout message, session-expired return |
| 2 | CEO Dashboard | KPI strip, cases by status/risk/country, workload chart, awaiting-approval queue, bottlenecks, recent activity |
| 3 | Role dashboards | Operations, Supervisor, Investigator, QA, Finance variants |
| 4 | Global search | Command-bar search (Ctrl+K) across cases, entities, evidence IDs, documents, findings; permission-filtered results with type grouping |
| 5 | Client list and Client profile | Searchable table; profile tabs: Overview, KYC, Engagements, Documents, Cases |
| 6 | Engagement | Terms, scope, contract/NDA, linked cases, commercials |
| 7 | Intake and Conflict Check | Stepper: Enquiry, KYC, Conflict, Assessment, Quotation, Approval; side-by-side potential-match viewer with decision form |
| 8 | New Case wizard | Client/engagement, type, jurisdiction, objectives and scope, risk, assignment; saves draft continuously |
| 9 | Case Overview | Header (ID, status, risk, deadline), status timeline, tabs: Summary, Plan, Tasks, Activity, Subjects, Sources, Evidence, Documents, Findings, Reports, Comms, Safety, Finance, Audit |
| 10 | Subjects and Entities | List plus relationship graph; duplicate/potential-match banner and review dialog |
| 11 | Investigation Plan | Structured editor, submit for review, supervisor approve/return with comments, version history |
| 12 | Tasks | List, Kanban and calendar views; overdue highlighting; quick add |
| 13 | Activity log | Chronological timeline, quick-entry from mobile, link to source/evidence |
| 14 | Sources and Information | Register with reliability and credibility ratings, corroboration links |
| 15 | Evidence register and detail | Table with hash status; detail with metadata, file preview, versions, custody timeline, transfer dialog |
| 16 | Documents | Folder tree, drag-and-drop upload, version history, approved-version lock |
| 17 | Findings and Analysis | Finding cards linking to evidence and information with confidence; traceability graph |
| 18 | Report builder | Section editor with finding/exhibit pickers, version compare, workflow bar |
| 19 | QA review | Checklist with pass/fail and comments, approve or return |
| 20 | Case Closure | Checklist gate, lessons learned form, retention class, supervisor approval |
| 21 | Archive | Read-only case view, searchable, legal hold indicator |
| 22 | Audit trail | Filterable log, case-scoped and global (admin), export |
| 23 | Notifications centre | Unread feed, preferences |
| 24 | Administration | Users, roles and permissions, workflow and folder templates, retention rules, legal holds, system settings |
| 25 | Safety | Field plan, check-in button, incident report (mobile-first) |
| 26 | User management | Searchable user list with status filters; add/invite, bulk import, edit, view profile and effective permissions, suspend, deactivate, reset MFA and password, revoke sessions |
| 27 | Roles and permission builder | Role list, create/clone/edit/delete, resource-action-scope-classification editor, feature toggles, role versions and rollback, members list |
| 28 | User overrides and access review | Per-user grants and denies with reason and expiry, pending two-person approvals, access-change log, periodic access certification |
| 29 | Recycle bin and restore | Administrator view of soft-deleted users, roles, cases, documents, evidence and other records; restore, or permanently purge with second-administrator approval and Legal Hold check |

---

## 19. Future Modules

| Version | Modules |
| --- | --- |
| V2 | CRM, client portal, billing and invoicing, digital signatures, native mobile app, advanced analytics, automated client updates |
| V3 | OSINT integrations, corporate registry integrations, adverse media monitoring, link analysis, entity resolution engine, intelligence risk scoring, digital forensics tooling integration, advanced intelligence dashboards |
| V4 | Integrated PDDC Intelligence Platform: due diligence, corporate investigations, intelligence, digital forensics, risk intelligence and analytics in one environment |

V1 data structures (entities, relationships, typed links, outbox events) are designed so these can be added without re-platforming.

---

## 20. Acceptance Criteria

### 20.1 Functional acceptance: complete fictional case

The developer demonstrates, end to end, **Client: ABC Insurance Ltd — Case: Corporate Fraud Investigation** without breaking any record relationship:

1. Create client and KYC · 2. Create engagement · 3. Run conflict check, including a fuzzy match decided by a manager · 4. Create case and define objective · 5. Add subjects · 6. Add related company and relationship · 7. Create investigation plan · 8. Assign investigator · 9. Create tasks · 10. Record activities · 11. Register sources · 12. Record information with credibility rating · 13. Upload evidence (hash recorded) · 14. Show chain of custody · 15. Upload documents with versions · 16. Create finding · 17. Link finding to evidence · 18. Draft report · 19. Supervisor review · 20. QA review (one return, then approve) · 21. Approve final report · 22. Record client delivery · 23. Close case with lessons learned · 24. Archive case · 25. Search archived case · 26. Review audit trail.

### 20.2 Measurable acceptance criteria

| Area | Criterion |
| --- | --- |
| Integrity | Altering a stored evidence file is detected by hash verification; custody events and audit rows cannot be updated or deleted by any application role |
| Access control | Automated tests prove each role/classification combination in Section 16; an unassigned investigator receives 403/404 on any other case, including via search and direct URL |
| Traceability | Every finding resolves to its evidence and sources in one click; report export lists all cited exhibits |
| Workflow | Illegal status transitions and self-approval are rejected; closure is blocked until all checks pass |
| Conflict | Pairs such as John Mensah / John K. Mensah and ABC Holdings Ltd / ABC Holdings Ghana Limited are flagged as Potential Matches and never auto-merged |
| Idempotency | Replaying any mutating request with the same key produces one record and the same response; duplicate emails are never sent on retry |
| Performance | Typical list/read API p95 under 300 ms; case page first meaningful paint under 2 s on a 4G connection; search under 1 s for 100,000 records |
| Notifications | Assignment, deadline and review notifications arrive in-app within 5 seconds and by email within 2 minutes; bounces are recorded |
| Resilience | Restore test recovers users, cases, documents, evidence metadata and audit logs from backup; point-in-time recovery demonstrated |
| Security | MFA enforced; independent penetration test with no open critical or high findings; dependency scan clean |
| Usability | A new investigator completes the basic workflow (view task, log activity, upload evidence) after 1 hour of training; works on phone and tablet |
| Audit | Every action listed in Section 13 appears in the trail with before/after values |
| User and role administration | An administrator can add, edit, view and deactivate users and create, edit and delete roles from the admin dashboard; a user with three roles receives the union of their permissions; an explicit deny overrides an allow; a permission change takes effect without re-login; high-risk changes need a second approver; the last administrator cannot be removed; every change appears in the audit trail |
| Administrator full CRUD | An automated test proves the Administrator can view, create, edit, delete (soft), restore, download and approve on every resource and feature, including newly added modules; evidence originals are never overwritten; audit and custody records cannot be edited or deleted by any role, and corrections appear as new entries |

### 20.3 Delivery gates before coding

PRD approval → system architecture → ERD → role and permission matrix → user journeys → wireframes/prototype → PDDC approval → technical specification → development → testing → UAT → security testing → deployment → training → production. Intellectual property, confidentiality, source-code access, data protection and exit terms are settled in a written development agreement.

---

## 21. Engineering Standards (apply to every module)

### 21.1 Clean architecture

- **Layers:** Presentation (UI) → Application (use cases) → Domain (entities, rules, state machines) → Infrastructure (PostgreSQL, storage, Resend, AI). Dependencies point inward only; the domain layer has no framework or database imports.
- **Modular monolith** organised by bounded context (IAM, CRM, Casework, Intel, Evidence, Docs, Reporting, Audit, Notify). Modules talk through interfaces and domain events, so a module can be extracted to a service later.
- Repository pattern for persistence, ports and adapters for external services (email, storage, AI, malware scanner), so providers can be swapped.
- Command/query separation: write use cases enforce rules and emit events; read queries are optimised and permission-filtered.
- Workflow and status rules live in the domain layer as explicit state machines.
- Configuration, not code, for folder templates, methodology stages, retention rules and classifications.

### 21.2 State management

| Concern | Standard |
| --- | --- |
| Server state | A query-cache library (for example TanStack Query) owns all server data: keyed by resource and filters, with stale-time, background refetch and automatic invalidation after mutations |
| Client/UI state | A small global store (for example Zustand) only for session, UI preferences, filters and wizard drafts; no server data duplicated in it |
| Forms | Form library with schema validation shared with the API contract; unsaved-change guards |
| Workflow state | Authoritative on the server; the UI only renders allowed transitions returned by the API |
| URL state | Filters, tabs, pagination and selected case live in the URL so views are shareable and restorable |
| Real-time | Server-sent events or WebSocket push invalidate the relevant query keys |

### 21.3 Caching and local storage

- **Server:** Redis (or equivalent) for permission lookups, reference data, dashboard aggregates and rate limits, with explicit invalidation on change. HTTP ETag and Cache-Control on read endpoints. PostgreSQL materialised views for heavy dashboard aggregates, refreshed on a schedule.
- **Client:** query cache with stale-while-revalidate; static assets fingerprinted and cached long-term; service worker for the app shell and offline-tolerant reads.
- **Local storage rules:** only non-sensitive data (UI preferences, theme, collapsed panels, recent searches, form drafts without confidential content). **Never store tokens, evidence, subject names, findings or report text in localStorage;** sensitive offline data, if ever needed, goes in encrypted IndexedDB, cleared on logout.
- Authenticated API responses carry `Cache-Control: private, no-store` where content is sensitive; shared caches never hold investigative data.

### 21.4 Optimised API calls

- Cursor-based pagination on all lists; field selection and expansion parameters to avoid over-fetching.
- Batch endpoints and request de-duplication on the client; no N+1 queries (eager loading, DataLoader pattern).
- Compression (Brotli/gzip), HTTP/2, conditional requests, indexes reviewed against real query plans.
- Long operations (report export, bulk upload, integrity scans, AI jobs) run as background jobs with progress endpoints.
- Optimistic UI updates for low-risk actions (task status), with rollback on failure; never optimistic for approvals, custody or evidence actions.

### 21.5 Lazy loading

Route-level code splitting; heavy components (relationship graph, report editor, file preview, charts) loaded on demand; tabs fetch data only when opened; lists use virtualised rendering; images and thumbnails load lazily; dashboard widgets load independently with skeleton placeholders.

### 21.6 Debouncing and throttling

Search-as-you-type 300 ms with cancellation of superseded requests; autosave of drafts 2 s after last keystroke; conflict-check lookups on name entry debounced 400 ms; window resize and scroll handlers throttled; double-click protection on all submit buttons.

### 21.7 Idempotency

- Client sends an `Idempotency-Key` (UUID) on every POST/PUT/PATCH that creates or changes state; the server stores key, request hash and response, and replays the original response for repeats within 24 hours; key reuse with a different body returns 422.
- ID generation (case, evidence, client numbers) is transactional so retries cannot skip or duplicate numbers.
- File uploads use resumable chunked upload keyed by content hash; the same file for the same case is not registered twice.
- Outbox consumers, webhooks (Resend) and scheduled jobs are idempotent and safe to replay.
- Workflow transitions are idempotent: repeating an already-applied transition returns the current state, not an error or a second audit entry.

### 21.8 Quality engineering

Unit tests on the domain layer; integration tests with a real PostgreSQL; contract tests for the API (OpenAPI); end-to-end tests for the six user journeys; CI pipeline with linting, type checks, security scans; structured logging with correlation IDs; infrastructure as code; environment separation (dev, staging, production).

---

## 22. AI Assistance (Free Cloud-Hosted Open-Source Models, Assistive Only)

Amendment 12 stands: AI is **not a core dependency of V1**. Clean, structured data comes first. The AI layer is built as an optional, swappable adapter so the platform works fully with it switched off.

### 22.1 Model and hosting

- **Free, open-source models served from the cloud**, accessed through a single **AI Gateway** inside the platform (an OpenAI-compatible adapter), so no GPU hosting is needed and providers can be swapped by configuration.
- **No free tier is truly unlimited.** Limits are per provider and per model, and change often, so the table below is a dated planning guide (October 2026) to be verified before build.
- Each AI output stores provider, model name and version.

| Provider (open-weight models) | Free-tier notes from public sources | Best use in IIMS |
| --- | --- | --- |
| OpenRouter (`:free` models) | 20+ free models, one API key, no card; commonly about 20 requests/min and 200/day, higher daily limits after a small credit top-up | Default gateway and fallback across many models |
| Groq | Roughly 30 requests/min and 500K tokens/day on some models; limits are per model | Fast interactive assistance |
| Cerebras | About 1M tokens/day, very high speed, fewer models | Summaries and batch jobs |
| Cloudflare Workers AI | About 10K neurons/day on the free plan, many Llama/Mistral-class models | Light tasks, embeddings, edge calls |
| Mistral (La Plateforme) | Generous monthly token allowance but tighter per-minute limits | Secondary fallback |

### How the platform achieves higher effective throughput

- **Multi-provider router with failover:** when one provider returns 429 or errors, the gateway retries the next provider with a compatible model, using exponential backoff and circuit breakers.
- **Queue and fairness:** all AI calls go through a job queue with per-user and per-case quotas, so one user cannot exhaust the shared free allowance.
- **Caching:** identical or near-identical requests (same document hash and prompt version) return the cached result from PostgreSQL/Redis; results are stored with the record they relate to.
- **Right-sized models:** small models for extraction and classification, larger models only for summaries and drafting.
- **Batching and background jobs:** document summaries and entity extraction run asynchronously rather than on page load; the UI shows progress.
- **Token discipline:** retrieval of only the relevant passages, trimmed prompts, and per-call token budgets.
- **Upgrade path:** the same gateway can switch to pay-as-you-go or a self-hosted model later with no application changes.

### 22.2 Permitted uses (V1-ready, V2+ enabled)

Document summarisation, entity extraction, duplicate/potential-match suggestion, timeline generation, relationship suggestions, report quality checking and analytical drafting assistance.

### 22.3 Accuracy, bias and accountability rules

No language model can be guaranteed 100% accurate, and a model asked to be biased toward a position will reduce accuracy. For an evidentiary platform the requirement is therefore stricter and safer:

- **Grounded answers only:** retrieval from the user's authorised case records; every statement cites the finding, information or evidence ID it came from; unsupported statements are not shown.
- **On-topic by design:** the assistant answers only about the selected case and PDDC procedures; off-topic requests are declined.
- **No unsupported conclusions:** the model may suggest, never assert; outputs are labelled "AI-generated suggestion", visually distinct, and never auto-saved as a finding.
- **Human-in-the-loop:** an authorised user must accept, edit or reject each suggestion; acceptance is audited with the accepting user and model version.
- **Permission-aware:** retrieval honours role, assignment and classification; STRICTLY RESTRICTED material is excluded unless the user holds access.
- **Bias control:** neutral prompts, balanced presentation of supporting and contradicting information, and periodic review of outputs by QA; no suggestions that rank people on protected characteristics.
- **Audit:** prompts, retrieved sources and outputs are logged (without exposing them to unauthorised users).

### 22.4 Data Protection Rules for Cloud AI

Investigation material is confidential, and a free cloud provider is a third party outside PDDC's control. Free tiers usually offer no data-processing agreement, and their terms may allow prompts to be logged or used to improve models. The platform therefore enforces:

- **AI is off by default** for every case and enabled only by a Supervisor or Operations Manager, with the decision recorded.
- **Classification gate:** only PUBLIC and INTERNAL content, and public-source (open-source intelligence) material, may be sent to a free cloud provider. CONFIDENTIAL, RESTRICTED and STRICTLY RESTRICTED content, human-source identities, evidence files and client financials are blocked by the gateway server-side.
- **Redaction and pseudonymisation:** names, ID numbers, account numbers and addresses are replaced with tokens before a request leaves PDDC and restored only on return; the mapping never leaves the platform.
- **Provider allow-list** maintained by administrators, with each provider's data-retention and training terms reviewed and recorded before use.
- **Client consent** is recorded in the engagement where client contracts or NDAs restrict third-party processing.
- **Local-model path:** sensitive cases can later use the same gateway pointed at a PDDC-controlled model, with no feature changes.
- Every outbound AI request is logged (provider, model, case, user, classification, token count) in the audit trail.

---

## 23. Interface and Experience Direction

The interface does not have to be green. The logo's navy fingerprint and green accent suggest a palette, but a case-management tool used for long sessions benefits from a calm, high-legibility design.

**Proposed direction: "Case File"**

- **Palette:** deep ink navy (#0B1F3A) for navigation and headers, warm paper off-white (#F7F6F2) for work surfaces, slate greys for text, and the PDDC signal green (#2E9E4F) used sparingly for primary actions and success states. Risk uses a distinct amber/red scale; evidence integrity uses a unique seal-style badge.
- **Dark mode** for night-shift and surveillance work, with the same accessible contrast ratios (WCAG AA minimum).
- **Typography:** a clean humanist sans for UI and a serif for report reading mode; monospace for IDs and hashes.
- **Signature elements:** a status timeline across the top of every case, a persistent classification banner, a "traceability strip" showing Source → Information → Evidence → Finding on every finding, and a custody timeline styled like a ledger.
- **Density control:** comfortable and compact table modes; minimal fields per form; progressive disclosure for advanced options.
- **Mobile-first field mode:** large touch targets for check-in, quick activity note, camera upload and task update.
- Logo placement: header, login, report covers and email templates, with a monochrome version for dark backgrounds.

---

## 24. Open Questions for PDDC

1. Which countries and offices go live first, and are there data-residency rules to honour?
2. Confirm RPO 15 minutes and RTO 4 hours, or set different targets.
3. Preferred hosting: PDDC-controlled cloud tenancy or on-premise for evidence storage?
4. Which free AI providers are acceptable to PDDC, and may any case data be sent to them (see Section 22.4), or only public-source material?
5. Do clients receive reports by secure link in V1 or by encrypted attachment only?
