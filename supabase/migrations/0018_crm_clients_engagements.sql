-- PDDC IIMS 0018 : clients, engagements and intake (PRD 8, 4.1).
--
-- The structure the PRD fixes is Client -> Engagement -> Case: one client has
-- many engagements, one engagement has many cases. Intake runs
-- Enquiry -> Client/KYC -> Conflict Check -> Assessment -> Quotation ->
-- Engagement Approval -> Case Creation, and "intake history is retained
-- permanently", so nothing here is ever hard-deleted.

-- ---------------------------------------------------------------------------
-- Human-readable identifiers.
--
-- CLI-YYYY-NNNNNN, generated server-side from a database sequence, never
-- client-side (PRD 5, 8.1). The sequence is per year, so a restart of the
-- numbering in January cannot collide with last year's.
--
-- Allocation is transactional: a rolled-back insert leaves a gap rather than
-- reusing a number, which is the safe direction for an identifier that appears
-- in client correspondence. PRD 21.7 requires that retries cannot skip or
-- duplicate, and a sequence gives exactly that.
-- ---------------------------------------------------------------------------
create table if not exists config.id_sequences (
  prefix      text not null,
  year        int  not null,
  last_value  bigint not null default 0,
  primary key (prefix, year)
);

alter table config.id_sequences enable row level security;
alter table config.id_sequences force  row level security;

create or replace function config.next_human_id(
  p_prefix text,
  p_width  int default 6
)
  returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_year int := extract(year from now())::int;
  v_next bigint;
begin
  -- The row lock serialises allocation, so two concurrent inserts cannot be
  -- handed the same number.
  insert into config.id_sequences (prefix, year, last_value)
  values (p_prefix, v_year, 1)
  on conflict (prefix, year) do update
    set last_value = config.id_sequences.last_value + 1
  returning last_value into v_next;

  return p_prefix || '-' || v_year::text || '-' || lpad(v_next::text, p_width, '0');
end
$$;

grant execute on function config.next_human_id(text, int) to iims_app;

-- ------------------------------------------------------------------ clients
create table if not exists crm.clients (
  id                  uuid primary key default gen_random_uuid(),
  client_id           text unique not null default config.next_human_id('CLI'),

  organisation_name   text not null,
  -- Normalised once on write so conflict screening and duplicate detection
  -- can index it. See 0019.
  organisation_name_normalised text,

  contact_person      text,
  position            text,
  telephone           text,
  email               extensions.citext,
  address             text,

  country_code        char(2) references iam.countries (code),
  office_id           uuid references iam.offices (id),
  industry            text,

  client_type         text not null default 'corporate'
                        check (client_type in ('corporate','financial_institution',
                                               'insurer','government','law_firm',
                                               'individual','ngo','other')),

  -- Know-your-customer state (PRD 8.1, 4.1).
  kyc_status          text not null default 'not_started'
                        check (kyc_status in ('not_started','in_progress',
                                              'completed','failed','expired')),
  kyc_completed_at    timestamptz,

  client_risk_rating  text not null default 'medium'
                        check (client_risk_rating in ('low','medium','high','critical')),

  account_manager_id  uuid references iam.users (id),
  date_onboarded      date,
  active_status       text not null default 'prospect'
                        check (active_status in ('prospect','active','dormant',
                                                 'suspended','closed')),

  classification      text not null default 'CONFIDENTIAL'
                        references iam.classification_levels (code),
  notes               text,

  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references iam.users (id),
  version     int not null default 1,
  deleted_at  timestamptz
);

create index if not exists clients_name_idx on crm.clients (organisation_name);
create index if not exists clients_status_idx on crm.clients (active_status) where deleted_at is null;
create index if not exists clients_kyc_idx on crm.clients (kyc_status) where deleted_at is null;
create index if not exists clients_manager_idx on crm.clients (account_manager_id);
create index if not exists clients_country_idx on crm.clients (country_code);

comment on table crm.clients is
  'Organisations PDDC works for. Client ID is CLI-YYYY-NNNNNN, allocated '
  'server-side from a sequence (PRD 8.1).';

-- -------------------------------------------------------- client contacts
create table if not exists crm.client_contacts (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references crm.clients (id) on delete cascade,
  full_name   text not null,
  position    text,
  email       extensions.citext,
  telephone   text,
  is_primary  boolean not null default false,
  notes       text,
  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references iam.users (id),
  version     int not null default 1,
  deleted_at  timestamptz
);

create index if not exists client_contacts_client_idx on crm.client_contacts (client_id);
-- At most one primary contact per client.
create unique index if not exists client_contacts_one_primary_idx
  on crm.client_contacts (client_id) where is_primary and deleted_at is null;

-- ------------------------------------------------------- client documents
-- Metadata only. The binary lives in object storage; this records the type,
-- the hash and the storage key (PRD 7.3, 8.1).
create table if not exists crm.client_documents (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references crm.clients (id) on delete cascade,
  document_type text not null
                  check (document_type in ('registration','identification','nda',
                                           'engagement_letter','contract',
                                           'purchase_order','kyc_evidence','other')),
  title         text not null,
  file_name     text,
  mime_type     text,
  file_size     bigint,
  sha256_hash   text,
  storage_key   text,
  classification text not null default 'CONFIDENTIAL'
                  references iam.classification_levels (code),
  expires_at    date,
  uploaded_at   timestamptz not null default now(),
  uploaded_by   uuid references iam.users (id),
  deleted_at    timestamptz
);

create index if not exists client_documents_client_idx on crm.client_documents (client_id);

-- --------------------------------------------------------------- enquiries
-- The first step of intake, kept permanently whether or not it becomes a case
-- (PRD 4.1).
create table if not exists crm.enquiries (
  id              uuid primary key default gen_random_uuid(),
  enquiry_id      text unique not null default config.next_human_id('ENQ'),

  received_at     timestamptz not null default now(),
  received_via    text not null default 'email'
                    check (received_via in ('email','telephone','meeting','website',
                                            'referral','existing_client','other')),

  -- Either an existing client, or the details of a prospect.
  client_id       uuid references crm.clients (id),
  prospect_name   text,
  contact_name    text,
  contact_email   extensions.citext,
  contact_phone   text,

  subject         text not null,
  summary         text,
  requested_service text,
  urgency         text not null default 'normal'
                    check (urgency in ('low','normal','high','urgent')),

  status          text not null default 'new'
                    check (status in ('new','assessing','conflict_check',
                                      'quoted','accepted','declined','lapsed')),
  decline_reason  text,

  assigned_to     uuid references iam.users (id),
  country_code    char(2) references iam.countries (code),
  office_id       uuid references iam.offices (id),
  classification  text not null default 'CONFIDENTIAL'
                    references iam.classification_levels (code),

  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references iam.users (id),
  version     int not null default 1,
  -- Deliberately no deleted_at: intake history is retained permanently.
  constraint enquiry_has_a_party check (client_id is not null or prospect_name is not null)
);

create index if not exists enquiries_status_idx on crm.enquiries (status, received_at desc);
create index if not exists enquiries_client_idx on crm.enquiries (client_id);
create index if not exists enquiries_assigned_idx on crm.enquiries (assigned_to);

-- ------------------------------------------------------------ KYC records
create table if not exists crm.kyc_records (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references crm.clients (id) on delete cascade,

  check_type    text not null
                  check (check_type in ('identity','registration','ownership',
                                        'sanctions','adverse_media','pep',
                                        'source_of_funds','other')),
  outcome       text not null default 'pending'
                  check (outcome in ('pending','pass','fail','inconclusive')),
  summary       text,
  evidence_document_id uuid references crm.client_documents (id),

  performed_by  uuid references iam.users (id),
  performed_at  timestamptz,
  expires_at    date,

  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references iam.users (id),
  version     int not null default 1
);

create index if not exists kyc_client_idx on crm.kyc_records (client_id);

-- ------------------------------------------------------------ engagements
create table if not exists crm.engagements (
  id              uuid primary key default gen_random_uuid(),
  engagement_id   text unique not null default config.next_human_id('ENG'),
  client_id       uuid not null references crm.clients (id),
  enquiry_id      uuid references crm.enquiries (id),

  title           text not null,
  engagement_type text not null default 'due_diligence'
                    check (engagement_type in ('due_diligence','corporate_investigation',
                                               'insurance_investigation','fraud_investigation',
                                               'background_screening','asset_search',
                                               'corporate_intelligence','digital_forensics',
                                               'retainer','other')),

  start_date      date,
  end_date        date,
  contract_reference text,
  nda_reference      text,
  scope_of_services  text,
  commercial_terms   text,

  responsible_manager_id uuid references iam.users (id),

  status          text not null default 'draft'
                    check (status in ('draft','pending_approval','approved',
                                      'active','on_hold','completed','cancelled')),
  approved_by     uuid references iam.users (id),
  approved_at     timestamptz,

  country_code    char(2) references iam.countries (code),
  office_id       uuid references iam.offices (id),
  classification  text not null default 'CONFIDENTIAL'
                    references iam.classification_levels (code),

  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references iam.users (id),
  version     int not null default 1,
  deleted_at  timestamptz,

  constraint engagement_dates_ordered
    check (end_date is null or start_date is null or end_date >= start_date)
);

create index if not exists engagements_client_idx on crm.engagements (client_id);
create index if not exists engagements_status_idx on crm.engagements (status) where deleted_at is null;
create index if not exists engagements_manager_idx on crm.engagements (responsible_manager_id);

-- --------------------------------------------------------------- touch
-- updated_at and the optimistic-locking version are maintained by the
-- database, reusing the trigger function from 0005.
do $$
declare
  t text;
begin
  foreach t in array array['clients','client_contacts','enquiries','kyc_records',
                           'engagements']
  loop
    execute format('drop trigger if exists %I_touch on crm.%I', t, t);
    execute format(
      'create trigger %I_touch before update on crm.%I '
      'for each row execute function iam.touch_row()', t, t);
  end loop;
end
$$;

-- ------------------------------------------------------------------- RLS
do $$
declare
  t text;
begin
  foreach t in array array['clients','client_contacts','client_documents',
                           'enquiries','kyc_records','engagements']
  loop
    execute format('alter table crm.%I enable row level security', t);
    execute format('alter table crm.%I force row level security', t);
  end loop;
end
$$;
