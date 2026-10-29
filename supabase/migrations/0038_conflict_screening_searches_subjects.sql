-- PDDC IIMS 0038 : conflict screening searches the subject register too
-- (PRD 8.3).
--
-- PRD 8.3 wants a conflict check to search "the client, the subjects,
-- companies, directors, shareholders, beneficial owners and related
-- entities". When 0019 was written none of those records existed, so
-- `crm.find_conflicts` searched `crm.clients` and said so: every match
-- carries the table it came from, and the screening screen never claimed to
-- have searched more than it had.
--
-- M5 built the register those records live in, so this adds it. The shape of
-- 0019 is why this is one query rather than a redesign: `matched_table` was
-- already generic over the source table, and a check run before today stays
-- readable with the scope it had.
--
-- WHAT IS SEARCHED, AND WHY IT IS MORE THAN ONE JOIN
-- An entity's aliases matter as much as its name here. "ABC Holdings Ghana
-- Limited" recorded as a trading name of "ABC Holdings Ltd" is exactly the
-- conflict a screening check exists to catch, and a check that searched only
-- the name would miss it. So the entity half is a union of the names and the
-- aliases, each reporting the entity it belongs to, and `greatest` keeps the
-- better of the two scores rather than averaging them: a strong match on an
-- alias is a strong match.
--
-- WHAT IS NOT SEARCHED
-- A merged record. It is a pointer to the survivor, which is searched, and
-- reporting both would show the reviewer the same conflict twice under two
-- names. A removed record is not searched either.

create or replace function crm.find_conflicts(
  p_terms     text[],
  p_threshold numeric default 0.30,
  p_limit     int default 50
)
  returns table (
    searched_term  text,
    matched_table  text,
    matched_id     uuid,
    matched_label  text,
    similarity     numeric,
    phonetic_match boolean,
    match_reason   text
  )
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
begin
  if not iam.has_permission('conflicts', 'view') then
    raise exception 'not permitted to run a conflict check'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with terms as (
    select t.term,
           crm.normalise_name(t.term) as normalised,
           crm.phonetic_key(t.term)   as phonetic
    from unnest(p_terms) as t(term)
    where crm.normalise_name(t.term) is not null
  ),
  -- Every name the subject register knows, with the entity it belongs to.
  -- An alias carries the entity's own name as its label, so the reviewer
  -- sees the record rather than the spelling that matched.
  subject_names as (
    select e.id, e.name as label, e.normalised_name as normalised
    from intel.entities e
    where e.deleted_at is null
      and e.resolution_status <> 'merged'
      and e.normalised_name is not null
    union all
    select e.id, e.name as label, a.normalised_alias as normalised
    from intel.entity_aliases a
    join intel.entities e on e.id = a.entity_id
    where e.deleted_at is null
      and e.resolution_status <> 'merged'
      and a.normalised_alias is not null
  ),
  client_hits as (
    select
      te.term as searched_term,
      'crm.clients'::text as matched_table,
      c.id as matched_id,
      c.organisation_name as matched_label,
      round(
        extensions.similarity(c.organisation_name_normalised, te.normalised)::numeric,
        3
      ) as similarity,
      (crm.phonetic_key(c.organisation_name) = te.phonetic) as phonetic_match,
      case
        when c.organisation_name_normalised = te.normalised
          then 'identical once suffixes and punctuation are normalised'
        when crm.phonetic_key(c.organisation_name) = te.phonetic
          then 'sounds the same'
        when c.organisation_name_normalised like '%' || te.normalised || '%'
          then 'the searched name appears within an existing name'
        when te.normalised like '%' || c.organisation_name_normalised || '%'
          then 'an existing name appears within the searched name'
        else 'similar spelling'
      end as match_reason
    from terms te
    join crm.clients c
      on c.deleted_at is null
     and c.organisation_name_normalised is not null
     and (
           extensions.similarity(c.organisation_name_normalised, te.normalised)
             >= p_threshold
           or crm.phonetic_key(c.organisation_name) = te.phonetic
           or c.organisation_name_normalised like '%' || te.normalised || '%'
           or te.normalised like '%' || c.organisation_name_normalised || '%'
         )
  ),
  subject_hits_all as (
    select
      te.term as searched_term,
      'intel.entities'::text as matched_table,
      s.id as matched_id,
      s.label as matched_label,
      round(extensions.similarity(s.normalised, te.normalised)::numeric, 3)
        as similarity,
      (crm.phonetic_key(s.label) = te.phonetic) as phonetic_match,
      case
        when s.normalised = te.normalised
          then 'identical once suffixes and punctuation are normalised'
        when crm.phonetic_key(s.label) = te.phonetic
          then 'sounds the same'
        when s.normalised like '%' || te.normalised || '%'
          then 'the searched name appears within a name on the register'
        when te.normalised like '%' || s.normalised || '%'
          then 'a name on the register appears within the searched name'
        else 'similar spelling'
      end as match_reason
    from terms te
    join subject_names s
      on extensions.similarity(s.normalised, te.normalised) >= p_threshold
      or crm.phonetic_key(s.label) = te.phonetic
      or s.normalised like '%' || te.normalised || '%'
      or te.normalised like '%' || s.normalised || '%'
  ),
  -- One row per entity per term, keeping its best match. Without this a
  -- company with three aliases appears three times for one search and the
  -- reviewer reads it as three conflicts.
  subject_hits as (
    select distinct on (searched_term, matched_id)
      searched_term, matched_table, matched_id, matched_label,
      similarity, phonetic_match, match_reason
    from subject_hits_all
    order by searched_term, matched_id, similarity desc, phonetic_match desc
  )
  select * from (
    select * from client_hits
    union all
    select * from subject_hits
  ) hits
  order by hits.phonetic_match desc, hits.similarity desc, hits.matched_label
  limit least(coalesce(p_limit, 50), 200);
end
$$;

comment on function crm.find_conflicts(text[], numeric, int) is
  'PRD 8.3 conflict screening across crm.clients and the intel.entities '
  'subject register, including entity aliases. Every row names the table it '
  'came from, so a check run before the register existed stays readable with '
  'the scope it had. Nothing is ever auto-merged or auto-declined: the '
  'function returns candidates and a manager decides.';

grant execute on function crm.find_conflicts(text[], numeric, int) to iims_app;

-- `intel.entities` and `intel.entity_aliases` are read here by a SECURITY
-- DEFINER function, which is deliberate and is the same shape as the client
-- half: a conflict check has to see records the person running it may not
-- open, or it would clear a conflict by failing to see it. What the check
-- returns is a name and a score, never the record's contents, and running one
-- is itself audited by the caller.

do $$
declare
  v_count int;
begin
  -- The function must still be reachable by the application, and must still
  -- refuse somebody without the permission. The second half cannot be probed
  -- here (the migration role is not iims_app), so this asserts the first.
  select count(*) into v_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'crm' and p.proname = 'find_conflicts';

  if v_count <> 1 then
    raise exception 'crm.find_conflicts is not defined exactly once: %', v_count;
  end if;
end
$$;
