-- PDDC IIMS 0043 : a human source's IDENTITY is strictly restricted, not the
-- whole source record (PRD 6.4).
--
-- 0036 read PRD 6.4 as raising the source row to STRICTLY_RESTRICTED. The
-- consequence, found by the end-to-end journey: nobody could record a human
-- source at all.
--
-- The arithmetic is unarguable. The trigger raised the row's classification
-- in the same statement as the insert, so `sources_insert` evaluated
-- `iam.has_permission('sources', 'create', 'STRICTLY_RESTRICTED')` on the
-- raised row. PRD 16 gives `sources:create` to the Investigator at a
-- CONFIDENTIAL ceiling, the Analyst and Forensics at CONFIDENTIAL and the
-- Supervisor at RESTRICTED. No role reaches STRICTLY_RESTRICTED. So every
-- attempt was refused, including by the role that actually meets human
-- sources.
--
-- WHAT PRD 6.4 ACTUALLY SAYS
-- "Human-source identities carry additional access controls (STRICTLY
-- RESTRICTED by default, named-user access only)." It says identities. The
-- distinction matters and is not a technicality:
--
--   What a human source SAID is intelligence the case team has to be able to
--   read. Classifying the record above the team hides the investigation from
--   the people conducting it, which cannot be the intent of a requirement
--   about protecting the source.
--
--   WHO the source is is need-to-know, and that is what the additional
--   control is for.
--
-- So the identity is protected independently of the record's classification,
-- which is how the platform was already reading it everywhere except this
-- trigger: `intel.sources.identity_restricted` is set for every human
-- source, the identity columns are gated inside the select on
-- `iam.has_permission('sources', 'view', 'STRICTLY_RESTRICTED')` whatever the
-- row's own classification is, a CHECK constraint refuses an identity on a
-- source that is not restricted, and the read model reports
-- `identity_withheld` so a screen says "withheld" rather than "none".
--
-- "Named-user access only" is then exactly what the platform delivers: no
-- role's ceiling reaches STRICTLY_RESTRICTED on `sources`, so an identity is
-- reachable by an administrator or by a named user given an explicit
-- `iam.user_permission_overrides` grant, and nobody else.
--
-- FOR PDDC TO CONFIRM
-- This is recorded in docs/PROGRESS.md as a question for PDDC, because it is
-- a reading of an ambiguous sentence rather than a certainty. If PDDC want
-- the whole record strictly restricted as well, the change is one line here
-- plus a ceiling in the role catalogue, and they should know that it means
-- the investigator who recruited the source cannot read back what the source
-- told them.

create or replace function intel.protect_human_source()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if new.source_type = 'human_source' then
    -- Always, and not from the application: this is the flag the identity
    -- columns' gate and the CHECK constraint both hang off.
    new.identity_restricted := true;
  end if;
  return new;
end
$$;

comment on function intel.protect_human_source() is
  'PRD 6.4: a human source has its identity restricted, decided at the table '
  'so no code path can omit it. The record''s own classification is left to '
  'whoever records it, because what a source said is intelligence the case '
  'team must be able to read; who they are is gated separately in the select '
  'and by the sources_identity_is_protected constraint.';

-- ---------------------------------------------------------------------------
-- Assertions, so the three parts of the control are all still present.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'intel.sources'::regclass
      and t.tgname = 'sources_protect_human'
      and not t.tgisinternal
  ) then
    raise exception
      'intel.sources has no sources_protect_human trigger, so a human source could be recorded with its identity unprotected (PRD 6.4)';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'intel.sources'::regclass
      and conname = 'sources_identity_is_protected'
  ) then
    raise exception
      'intel.sources lost sources_identity_is_protected, so an identity could be recorded on an unrestricted source';
  end if;

  -- The identity columns must still be gated on STRICTLY_RESTRICTED inside
  -- the select. That lives in the repository rather than in a policy, so all
  -- this can check is that the policy has not been widened to expose them.
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'intel' and tablename = 'sources'
      and policyname = 'sources_select'
      and qual not like '%has_permission%'
  ) then
    raise exception 'sources_select no longer checks iam.has_permission';
  end if;
end
$$;
