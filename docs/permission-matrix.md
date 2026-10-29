# Permission matrix

Generated from the live database by `node --env-file=.env.local scripts/doc-schema.mjs`.
This is what the platform actually enforces, not what was intended: it is read from `iam.roles`, `iam.role_permissions` and `iam.permissions`.

Read on 2026-10-28.

PRD 16 is the starting set, and an administrator may change any cell through the permission builder, so this file is a snapshot rather than a specification.

Letters follow PRD 16:

**V** view, **C** create, **E** edit, **U** upload, **D** download, **S** share, **A** approve, **X** delete, **P** export, **G** assign, **F** configure, **\*** everything.

A dash means no grant at all.

| Resource | administrator | analyst | auditor | ceo | compliance_officer | coo | employee | finance | forensics | hr_manager | investigator | legal_counsel | manager | operations_manager | qa_reviewer | records_custodian | supervisor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| * | * | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
| audit | - | - | V | V | V | - | - | - | - | - | - | - | - | - | - | - | V (team) |
| cases | - | E V (assigned) | V | V | V | G E V | - | V | V (assigned) | - | E V (assigned) | V | G C E V | A archive G close C X E V | V | V | A G close C E V |
| clients | - | - | - | V | V | - | - | V | - | - | V (assigned) | - | - | C X E V | - | - | V (team) |
| conflicts | - | - | - | - | A V | - | - | - | - | - | - | - | - | A V | - | - | V (team) |
| custody | - | C V (assigned) | V | V | V | - | - | - | C V (assigned) | - | C V (assigned) | - | - | V | V (assigned) | C V | C V (team) |
| dashboards | - | V (own) | V | V | V | V | V (own) | V | V (own) | V | V (own) | V (own) | V (team) | V | V (own) | V (own) | V (team) |
| documents | - | C D U V (assigned) | V | V | V | - | - | - | C D U V (assigned) | - | C D E U V (assigned) | V (assigned) | - | V | D V (assigned) | V | C D E U V (team) |
| engagements | - | - | - | V | V | - | - | V | - | - | V (assigned) | - | - | A C X E V | - | - | V (team) |
| entities | - | C E V (assigned) | - | V | - | - | - | - | V (assigned) | - | C E V (assigned) | - | - | merge V | V (assigned) | - | C E merge V |
| evidence | - | D V (assigned) | V | V | V | - | - | - | C D E U V (assigned) | - | C D U V (assigned) | V (assigned) | - | V | D V (assigned) | E V | D U V (team) |
| financials | - | - | - | V | - | - | - | C E P V | - | - | - | - | - | C E V | - | - | V (team) |
| findings | - | C E V (assigned) | V | V | - | - | - | - | C E V (assigned) | - | C E V (assigned) | V (assigned) | - | A V | V (assigned) | - | A V |
| information | - | C E V (assigned) | - | V | - | - | - | - | V (assigned) | - | C E V (assigned) | - | - | V | V (assigned) | - | C E V (team) |
| notifications | - | - | - | - | - | - | E V (own) | - | - | - | - | - | - | - | - | - | - |
| plans | - | V (assigned) | - | V | - | A V | - | - | - | - | C E V (assigned) | - | - | V | V (assigned) | - | A V (team) |
| profile | - | - | - | - | - | - | E V (own) | - | - | - | - | - | - | - | - | - | - |
| qa | - | - | - | - | - | - | - | - | - | - | - | - | - | - | C E V (assigned) | - | - |
| reports | - | C E V (assigned) | V | A V | V | V | - | - | C E V (assigned) | - | C E V (assigned) | A V (assigned) | - | V | A V (assigned) | - | A V (team) |
| settings | - | - | V | - | V | - | - | - | - | - | - | - | - | - | - | - | - |
| sources | - | C E V (assigned) | - | V | - | - | - | - | V (assigned) | - | C E V (assigned) | - | - | V | V (assigned) | - | C E V (team) |
| tasks | - | C E V (assigned) | - | V | - | V | E V (own) | - | C E V (assigned) | - | C E V (assigned) | - | G C E V | G C E V | V (assigned) | - | G C E V |
| time | - | - | - | V | - | - | C E V (own) | V | - | - | - | - | V (team) | V | - | - | V (team) |
| users | - | - | V | V | - | V | - | - | - | C E V | - | - | V (team) | V | - | - | - |

## Ceilings

A grant also carries the highest classification it reaches. The actor's own clearance applies on top, so the effective ceiling is the lower of the two.

| Role | Highest ceiling granted |
| --- | --- |
| administrator | STRICTLY_RESTRICTED |
| analyst | CONFIDENTIAL |
| auditor | RESTRICTED |
| ceo | RESTRICTED |
| compliance_officer | RESTRICTED |
| coo | RESTRICTED |
| employee | INTERNAL |
| finance | INTERNAL |
| forensics | RESTRICTED |
| hr_manager | INTERNAL |
| investigator | CONFIDENTIAL |
| legal_counsel | RESTRICTED |
| manager | RESTRICTED |
| operations_manager | STRICTLY_RESTRICTED |
| qa_reviewer | RESTRICTED |
| records_custodian | RESTRICTED |
| supervisor | STRICTLY_RESTRICTED |
