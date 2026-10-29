-- PDDC IIMS 0020 : row-level security for the CRM schema.
--
-- The authoritative check is still the one in the use case (PRD 14, "deny by
-- default" on every request). These policies are the second line: if a query
-- reaches the database without one, it returns nothing rather than everything.
--
-- Two things shape every policy below:
--
--   Classification. A row is readable only if the caller's clearance reaches
--   its classification. iam.has_permission does both halves: the permission's
--   own ceiling and the user's personal clearance (PRD 7.4, 3.2).
--
--   Finance sees no investigative content (PRD 3.1, 16). Finance holds
--   clients:view and engagements:view so it can bill, which these policies
--   allow, and holds nothing on cases, evidence or findings, which it
--   therefore cannot read at all.

-- ---------------------------------------------------------------------------
-- Clients.
-- ---------------------------------------------------------------------------
drop policy if exists clients_select on crm.clients;
create policy clients_select on crm.clients
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('clients', 'view', classification)
  );

-- The recycle bin needs to see soft-deleted rows, and only with delete rights.
drop policy if exists clients_select_deleted on crm.clients;
create policy clients_select_deleted on crm.clients
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('clients', 'delete', classification)
  );

drop policy if exists clients_insert on crm.clients;
create policy clients_insert on crm.clients
  for insert to iims_app
  with check (iam.has_permission('clients', 'create', classification));

drop policy if exists clients_update on crm.clients;
create policy clients_update on crm.clients
  for update to iims_app
  using (iam.has_permission('clients', 'edit', classification))
  with check (iam.has_permission('clients', 'edit', classification));

-- No DELETE policy anywhere in this schema: removal is a soft delete applied
-- as an UPDATE, so a record is always recoverable (PRD 3.5).

-- ---------------------------------------------------------------------------
-- Contacts, documents and KYC inherit their client's reachability.
--
-- Written as an EXISTS against crm.clients rather than repeating the
-- permission logic, so a client the caller cannot see takes its children with
-- it and the two can never disagree.
-- ---------------------------------------------------------------------------
-- NOTE ON QUALIFYING THE OUTER COLUMN
-- crm.clients has BOTH `id` (uuid) and `client_id` (the human-readable
-- CLI-YYYY-NNNNNN text). Inside a subquery the inner table is resolved first,
-- so an unqualified `client_id` binds to crm.clients.client_id (text) rather
-- than to the outer row's uuid, and the policy fails to create with
-- "operator does not exist: uuid = text". The outer column is therefore
-- always written out in full.
do $$
declare
  t text;
begin
  foreach t in array array['client_contacts','client_documents','kyc_records']
  loop
    execute format('drop policy if exists %I_select on crm.%I', t, t);
    execute format($f$
      create policy %I_select on crm.%I
        for select to iims_app
        using (exists (select 1 from crm.clients c where c.id = crm.%I.client_id))
    $f$, t, t, t);

    execute format('drop policy if exists %I_insert on crm.%I', t, t);
    execute format($f$
      create policy %I_insert on crm.%I
        for insert to iims_app
        with check (
          iam.has_permission('clients', 'edit')
          and exists (select 1 from crm.clients c where c.id = crm.%I.client_id)
        )
    $f$, t, t, t);

    execute format('drop policy if exists %I_update on crm.%I', t, t);
    execute format($f$
      create policy %I_update on crm.%I
        for update to iims_app
        using (
          iam.has_permission('clients', 'edit')
          and exists (select 1 from crm.clients c where c.id = crm.%I.client_id)
        )
        with check (
          iam.has_permission('clients', 'edit')
          and exists (select 1 from crm.clients c where c.id = crm.%I.client_id)
        )
    $f$, t, t, t, t);
  end loop;
end
$$;

-- A document's own classification can be stricter than its client's, so it is
-- checked in addition to the client being reachable.
drop policy if exists client_documents_select on crm.client_documents;
create policy client_documents_select on crm.client_documents
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('clients', 'view', classification)
    and exists (select 1 from crm.clients c where c.id = crm.client_documents.client_id)
  );

-- ---------------------------------------------------------------------------
-- Enquiries. Intake is run by operations, and an investigator sees an enquiry
-- only once it has become their case, so the read requires clients:view.
-- ---------------------------------------------------------------------------
drop policy if exists enquiries_select on crm.enquiries;
create policy enquiries_select on crm.enquiries
  for select to iims_app
  using (
    iam.has_permission('clients', 'view', classification)
    or assigned_to = iam.current_user_id()
  );

drop policy if exists enquiries_insert on crm.enquiries;
create policy enquiries_insert on crm.enquiries
  for insert to iims_app
  with check (iam.has_permission('clients', 'create', classification));

drop policy if exists enquiries_update on crm.enquiries;
create policy enquiries_update on crm.enquiries
  for update to iims_app
  using (
    iam.has_permission('clients', 'edit', classification)
    or assigned_to = iam.current_user_id()
  )
  with check (
    iam.has_permission('clients', 'edit', classification)
    or assigned_to = iam.current_user_id()
  );

-- ---------------------------------------------------------------------------
-- Engagements.
-- ---------------------------------------------------------------------------
drop policy if exists engagements_select on crm.engagements;
create policy engagements_select on crm.engagements
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('engagements', 'view', classification)
  );

drop policy if exists engagements_select_deleted on crm.engagements;
create policy engagements_select_deleted on crm.engagements
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('engagements', 'delete', classification)
  );

drop policy if exists engagements_insert on crm.engagements;
create policy engagements_insert on crm.engagements
  for insert to iims_app
  with check (iam.has_permission('engagements', 'create', classification));

drop policy if exists engagements_update on crm.engagements;
create policy engagements_update on crm.engagements
  for update to iims_app
  using (iam.has_permission('engagements', 'edit', classification))
  with check (iam.has_permission('engagements', 'edit', classification));

-- ---------------------------------------------------------------------------
-- Conflict checks.
--
-- Note the asymmetry: recording a DECISION needs conflicts:approve, while
-- running a check needs only conflicts:view. That is the PRD's division:
-- anyone screening can see a potential match, but only an authorised manager
-- clears or declines it (PRD 8.3, 16).
-- ---------------------------------------------------------------------------
drop policy if exists conflict_checks_select on crm.conflict_checks;
create policy conflict_checks_select on crm.conflict_checks
  for select to iims_app
  using (iam.has_permission('conflicts', 'view'));

drop policy if exists conflict_checks_insert on crm.conflict_checks;
create policy conflict_checks_insert on crm.conflict_checks
  for insert to iims_app
  with check (iam.has_permission('conflicts', 'view'));

drop policy if exists conflict_checks_decide on crm.conflict_checks;
create policy conflict_checks_decide on crm.conflict_checks
  for update to iims_app
  using (iam.has_permission('conflicts', 'approve'))
  with check (iam.has_permission('conflicts', 'approve'));

drop policy if exists conflict_matches_select on crm.conflict_matches;
create policy conflict_matches_select on crm.conflict_matches
  for select to iims_app
  using (
    -- Qualified for the same reason as above: crm.conflict_checks has both
    -- `id` (uuid) and `check_id` (the human-readable text identifier).
    exists (
      select 1 from crm.conflict_checks c
      where c.id = crm.conflict_matches.check_id
    )
  );

drop policy if exists conflict_matches_insert on crm.conflict_matches;
create policy conflict_matches_insert on crm.conflict_matches
  for insert to iims_app
  with check (iam.has_permission('conflicts', 'view'));

-- ---------------------------------------------------------------------------
-- The identifier sequence table is written only through
-- config.next_human_id(), which is SECURITY DEFINER, so the application role
-- needs no policy of its own and gets none.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Permission atoms for the new resources, so the roles seeded in 0009 can
-- actually reach them. The matrix in PRD 16 already names who gets what; this
-- adds the atoms the matrix refers to for enquiries and KYC, which ride on the
-- client permissions rather than having their own resource.
-- ---------------------------------------------------------------------------
select config.grant_role_permission('operations_manager', 'clients', 'delete', 'all', 'CONFIDENTIAL');
select config.grant_role_permission('operations_manager', 'engagements', 'delete', 'all', 'CONFIDENTIAL');
select config.grant_role_permission('compliance_officer', 'clients', 'view', 'all', 'RESTRICTED');
select config.grant_role_permission('compliance_officer', 'engagements', 'view', 'all', 'RESTRICTED');
