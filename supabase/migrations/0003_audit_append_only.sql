-- PDDC IIMS 0003: append-only, hash-chained audit trail (PRD §13).
--
-- Four independent locks make these tables append-only for every application
-- role. All four are needed; none is redundant:
--
--   1. PRIVILEGE  iims_app holds INSERT only (0002). TRUNCATE never granted.
--   2. RLS        ENABLE + FORCE, one INSERT policy, no UPDATE/DELETE policy.
--   3. ROW TRIGGER    BEFORE UPDATE OR DELETE raises an exception.
--   4. STATEMENT TRIGGER  BEFORE TRUNCATE raises: row triggers never fire
--                         for TRUNCATE, so this is a separate trigger.
--
-- FORCE ROW LEVEL SECURITY is not optional: postgres owns these tables and a
-- table owner bypasses its own policies without it.
--
-- RULEs were considered and rejected: `DO INSTEAD NOTHING` discards the
-- statement silently, so the caller believes it succeeded.

-- ---------------------------------------------------------------------------
-- The chain head. A single row, taken FOR UPDATE inside the insert trigger to
-- serialize appends.
--
-- Without this lock two concurrent inserts read the same tail and fork the
-- chain: silently, and only under load. This is the single most important
-- line in the file.
-- ---------------------------------------------------------------------------
create table if not exists audit.chain_head (
  id          boolean primary key default true,
  last_hash   text    not null,
  entry_count bigint  not null default 0,
  updated_at  timestamptz not null default now(),
  constraint chain_head_singleton check (id)
);

insert into audit.chain_head (id, last_hash, entry_count)
values (true, repeat('0', 64), 0)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- The audit log itself (PRD §13 "Audit record").
-- ---------------------------------------------------------------------------
create table if not exists audit.audit_log (
  audit_id        uuid primary key default extensions.gen_random_uuid(),
  seq             bigserial     not null,
  actor_user_id   uuid,                      -- null only for system actions
  actor_email     text,                      -- denormalised: survives user deletion
  action          text          not null,
  occurred_at     timestamptz   not null default now(),
  record_type     text,
  record_id       text,
  case_id         uuid,
  ip              inet,
  user_agent      text,
  before_value    jsonb,
  after_value     jsonb,
  reason          text,                      -- mandatory for admin overrides (§3.5)
  correlation_id  uuid,                      -- request correlation (§21.8)
  classification  text,
  prev_hash       text          not null,
  row_hash        text          not null
);

create index if not exists audit_log_occurred_at_idx on audit.audit_log (occurred_at desc);
create index if not exists audit_log_actor_idx       on audit.audit_log (actor_user_id, occurred_at desc);
create index if not exists audit_log_case_idx        on audit.audit_log (case_id, occurred_at desc);
create index if not exists audit_log_action_idx      on audit.audit_log (action, occurred_at desc);
create index if not exists audit_log_record_idx      on audit.audit_log (record_type, record_id);
create unique index if not exists audit_log_seq_idx  on audit.audit_log (seq);

-- Separate read-access log (PRD §13: viewing the audit log is itself audited).
create table if not exists audit.access_log (
  access_id      uuid primary key default extensions.gen_random_uuid(),
  actor_user_id  uuid        not null,
  resource       text        not null,
  resource_id    text,
  case_id        uuid,
  action         text        not null default 'view',
  occurred_at    timestamptz not null default now(),
  ip             inet,
  user_agent     text,
  correlation_id uuid
);

create index if not exists access_log_actor_idx on audit.access_log (actor_user_id, occurred_at desc);
create index if not exists access_log_case_idx  on audit.access_log (case_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Hash chain.
--
-- row_hash = sha256(prev_hash || canonical_json_of_row)
--
-- This CANNOT be a generated column: a generated expression may only
-- reference columns of its own row, and prev_hash comes from the previous
-- one. Hence a BEFORE INSERT trigger.
--
-- SECURITY DEFINER: the trigger must READ
-- chain_head, but iims_app deliberately has no SELECT on the audit schema.
-- search_path is pinned empty, so every reference is schema-qualified.
-- ---------------------------------------------------------------------------
create or replace function audit.append_hash_chain()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_prev    text;
  v_payload text;
begin
  -- Serialize appends. Any concurrent insert blocks here until we commit,
  -- which is what keeps the chain a single unbroken line.
  select last_hash into v_prev
  from audit.chain_head
  where id
  for update;

  if v_prev is null then
    raise exception 'audit chain head is missing; refusing to append'
      using errcode = 'data_exception';
  end if;

  new.prev_hash := v_prev;

  -- Canonical payload. Explicit column list, fixed order: never to_jsonb(new),
  -- whose key order and future column additions would both change the hash
  -- and break verification of historical rows.
  v_payload := concat_ws('|',
    new.audit_id::text,
    coalesce(new.actor_user_id::text, ''),
    coalesce(new.actor_email, ''),
    new.action,
    extract(epoch from new.occurred_at)::text,
    coalesce(new.record_type, ''),
    coalesce(new.record_id, ''),
    coalesce(new.case_id::text, ''),
    coalesce(host(new.ip), ''),
    coalesce(new.user_agent, ''),
    coalesce(new.before_value::text, ''),
    coalesce(new.after_value::text, ''),
    coalesce(new.reason, ''),
    coalesce(new.correlation_id::text, ''),
    coalesce(new.classification, '')
  );

  new.row_hash := encode(
    extensions.digest(convert_to(v_prev || '|' || v_payload, 'UTF8'), 'sha256'),
    'hex'
  );

  update audit.chain_head
  set last_hash   = new.row_hash,
      entry_count = entry_count + 1,
      updated_at  = now()
  where id;

  return new;
end
$$;


drop trigger if exists audit_log_hash_chain on audit.audit_log;
create trigger audit_log_hash_chain
  before insert on audit.audit_log
  for each row execute function audit.append_hash_chain();

-- ---------------------------------------------------------------------------
-- Immutability guards.
-- ---------------------------------------------------------------------------
create or replace function audit.reject_mutation()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  raise exception
    'append-only: % on %.% is not permitted. Corrections are added as new entries (PRD §13).',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end
$$;


drop trigger if exists audit_log_no_mutate on audit.audit_log;
create trigger audit_log_no_mutate
  before update or delete on audit.audit_log
  for each row execute function audit.reject_mutation();

-- TRUNCATE needs its own statement-level trigger: row triggers never fire.
drop trigger if exists audit_log_no_truncate on audit.audit_log;
create trigger audit_log_no_truncate
  before truncate on audit.audit_log
  for each statement execute function audit.reject_mutation();

drop trigger if exists access_log_no_mutate on audit.access_log;
create trigger access_log_no_mutate
  before update or delete on audit.access_log
  for each row execute function audit.reject_mutation();

drop trigger if exists access_log_no_truncate on audit.access_log;
create trigger access_log_no_truncate
  before truncate on audit.access_log
  for each statement execute function audit.reject_mutation();

-- Protect the chain head from being rewound.
drop trigger if exists chain_head_no_delete on audit.chain_head;
create trigger chain_head_no_delete
  before delete on audit.chain_head
  for each row execute function audit.reject_mutation();

-- ---------------------------------------------------------------------------
-- Row-level security. INSERT only, and FORCEd so the owner is bound too.
-- ---------------------------------------------------------------------------
alter table audit.audit_log    enable row level security;
alter table audit.audit_log    force  row level security;
alter table audit.access_log   enable row level security;
alter table audit.access_log   force  row level security;
alter table audit.chain_head   enable row level security;
alter table audit.chain_head   force  row level security;

drop policy if exists audit_log_insert on audit.audit_log;
create policy audit_log_insert on audit.audit_log
  for insert to iims_app
  with check (true);

drop policy if exists access_log_insert on audit.access_log;
create policy access_log_insert on audit.access_log
  for insert to iims_app
  with check (true);

-- Deliberately no SELECT, UPDATE or DELETE policy for iims_app. Reading the
-- audit trail is a privileged operation that goes through
-- audit.read_audit_log() below, which records the read in access_log.
-- Deliberately no policy of any kind on chain_head: only the SECURITY DEFINER
-- trigger touches it.

-- ---------------------------------------------------------------------------
-- Reading the trail. SECURITY DEFINER so it can see rows iims_app cannot,
-- and it logs the read itself (PRD §13: "viewing the audit log is itself
-- audited"). Permission filtering is applied by the caller in the application
-- layer; this function only enforces that a reader is identified.
-- ---------------------------------------------------------------------------
create or replace function audit.read_audit_log(
  p_case_id     uuid    default null,
  p_actor       uuid    default null,
  p_action      text    default null,
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_limit       int     default 100,
  p_before_seq  bigint  default null   -- cursor pagination (PRD §21.4)
)
  returns setof audit.audit_log
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_reader uuid := nullif(current_setting('iims.user_id', true), '')::uuid;
begin
  if v_reader is null then
    raise exception 'audit read requires an identified reader'
      using errcode = 'insufficient_privilege';
  end if;

  insert into audit.access_log (actor_user_id, resource, resource_id, case_id, action,
                                correlation_id)
  values (v_reader, 'audit.audit_log', null, p_case_id, 'search',
          nullif(current_setting('iims.request_id', true), '')::uuid);

  return query
  select *
  from audit.audit_log a
  where (p_case_id is null or a.case_id = p_case_id)
    and (p_actor is null or a.actor_user_id = p_actor)
    and (p_action is null or a.action = p_action)
    and (p_from is null or a.occurred_at >= p_from)
    and (p_to is null or a.occurred_at <= p_to)
    and (p_before_seq is null or a.seq < p_before_seq)
  order by a.seq desc
  limit least(coalesce(p_limit, 100), 500);
end
$$;

grant execute on function audit.read_audit_log(uuid, uuid, text, timestamptz, timestamptz, int, bigint)
  to iims_app;

-- ---------------------------------------------------------------------------
-- Chain verification. Recomputes every hash in sequence and reports the first
-- divergence. Used by scripts/verify-audit-chain.mjs and by the scheduled
-- integrity job.
-- ---------------------------------------------------------------------------
create or replace function audit.verify_chain(p_from_seq bigint default 0)
  returns table (
    checked     bigint,
    first_bad_seq bigint,
    first_bad_id  uuid,
    ok          boolean
  )
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  r         record;
  v_expect  text;
  v_payload text;
  v_hash    text;
  v_count   bigint := 0;
  v_bad_seq bigint := null;
  v_bad_id  uuid   := null;
begin
  v_expect := repeat('0', 64);

  for r in
    select * from audit.audit_log where seq > p_from_seq order by seq asc
  loop
    v_count := v_count + 1;

    v_payload := concat_ws('|',
      r.audit_id::text,
      coalesce(r.actor_user_id::text, ''),
      coalesce(r.actor_email, ''),
      r.action,
      extract(epoch from r.occurred_at)::text,
      coalesce(r.record_type, ''),
      coalesce(r.record_id, ''),
      coalesce(r.case_id::text, ''),
      coalesce(host(r.ip), ''),
      coalesce(r.user_agent, ''),
      coalesce(r.before_value::text, ''),
      coalesce(r.after_value::text, ''),
      coalesce(r.reason, ''),
      coalesce(r.correlation_id::text, ''),
      coalesce(r.classification, '')
    );

    v_hash := encode(
      extensions.digest(convert_to(r.prev_hash || '|' || v_payload, 'UTF8'), 'sha256'),
      'hex'
    );

    if r.prev_hash is distinct from v_expect or r.row_hash is distinct from v_hash then
      v_bad_seq := r.seq;
      v_bad_id  := r.audit_id;
      exit;
    end if;

    v_expect := r.row_hash;
  end loop;

  return query select v_count, v_bad_seq, v_bad_id, (v_bad_seq is null);
end
$$;

grant execute on function audit.verify_chain(bigint) to iims_app;

-- ---------------------------------------------------------------------------
-- Off-system anchors. Hash chaining alone proves nothing against an actor who
-- can rewrite the whole chain; anchoring the head outside this project is what
-- makes tampering detectable (see the residual-risk note in 0002).
-- ---------------------------------------------------------------------------
create table if not exists audit.chain_anchors (
  anchor_id     uuid primary key default extensions.gen_random_uuid(),
  anchored_at   timestamptz not null default now(),
  head_hash     text        not null,
  entry_count   bigint      not null,
  exported_to   text,                      -- where the signed copy was published
  export_status text        not null default 'pending'
    check (export_status in ('pending', 'exported', 'failed')),
  signature     text
);

create index if not exists chain_anchors_anchored_at_idx
  on audit.chain_anchors (anchored_at desc);

alter table audit.chain_anchors enable row level security;
alter table audit.chain_anchors force  row level security;

drop trigger if exists chain_anchors_no_delete on audit.chain_anchors;
create trigger chain_anchors_no_delete
  before delete on audit.chain_anchors
  for each row execute function audit.reject_mutation();
