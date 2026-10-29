-- PDDC IIMS 0039 : fixes an ambiguity 0038 introduced.
--
-- 0038 named its CTE columns after the function's own OUT parameters:
-- `searched_term`, `matched_id` and the rest. Inside a plpgsql function the
-- OUT parameters are in scope as variables, so `distinct on (searched_term,
-- matched_id)` is ambiguous between the column and the variable, and Postgres
-- refuses the whole query rather than guessing. Every conflict check failed
-- with "column reference searched_term is ambiguous".
--
-- Caught immediately by the existing conflict-screening tests, which is the
-- reason they were written against the function rather than against the
-- screen. The fix is to give the intermediate columns names that cannot
-- collide and map them to the output once, at the end.
--
-- The alternative, `#variable_conflict use_column`, would work and is worse:
-- it makes the function's behaviour depend on a pragma a later reader has to
-- know about, where distinct names need no explanation at all.

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
  -- An alias carries the entity's own name as its label, so the reviewer sees
  -- the record rather than the spelling that matched.
  subject_names as (
    select e.id as ent_id, e.name as ent_label, e.normalised_name as ent_normalised
    from intel.entities e
    where e.deleted_at is null
      and e.resolution_status <> 'merged'
      and e.normalised_name is not null
    union all
    select e.id, e.name, a.normalised_alias
    from intel.entity_aliases a
    join intel.entities e on e.id = a.entity_id
    where e.deleted_at is null
      and e.resolution_status <> 'merged'
      and a.normalised_alias is not null
  ),
  client_hits as (
    select
      te.term      as hit_term,
      'crm.clients'::text as hit_table,
      c.id         as hit_id,
      c.organisation_name as hit_label,
      round(
        extensions.similarity(c.organisation_name_normalised, te.normalised)::numeric,
        3
      )            as hit_score,
      (crm.phonetic_key(c.organisation_name) = te.phonetic) as hit_phonetic,
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
      end          as hit_reason
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
      te.term      as hit_term,
      'intel.entities'::text as hit_table,
      s.ent_id     as hit_id,
      s.ent_label  as hit_label,
      round(extensions.similarity(s.ent_normalised, te.normalised)::numeric, 3)
                   as hit_score,
      (crm.phonetic_key(s.ent_label) = te.phonetic) as hit_phonetic,
      case
        when s.ent_normalised = te.normalised
          then 'identical once suffixes and punctuation are normalised'
        when crm.phonetic_key(s.ent_label) = te.phonetic
          then 'sounds the same'
        when s.ent_normalised like '%' || te.normalised || '%'
          then 'the searched name appears within a name on the register'
        when te.normalised like '%' || s.ent_normalised || '%'
          then 'a name on the register appears within the searched name'
        else 'similar spelling'
      end          as hit_reason
    from terms te
    join subject_names s
      on extensions.similarity(s.ent_normalised, te.normalised) >= p_threshold
      or crm.phonetic_key(s.ent_label) = te.phonetic
      or s.ent_normalised like '%' || te.normalised || '%'
      or te.normalised like '%' || s.ent_normalised || '%'
  ),
  -- One row per entity per term, keeping its best match. Without this a
  -- company with three names that all match appears three times for one
  -- search, and a reviewer reads that as three conflicts.
  subject_hits as (
    select distinct on (hit_term, hit_id)
      hit_term, hit_table, hit_id, hit_label, hit_score, hit_phonetic, hit_reason
    from subject_hits_all
    order by hit_term, hit_id, hit_score desc, hit_phonetic desc
  ),
  hits as (
    select * from client_hits
    union all
    select * from subject_hits
  )
  select
    h.hit_term, h.hit_table, h.hit_id, h.hit_label,
    h.hit_score, h.hit_phonetic, h.hit_reason
  from hits h
  order by h.hit_phonetic desc, h.hit_score desc, h.hit_label
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
