-- PDDC IIMS 0001: schemas and extensions (PRD §17.1).
--
-- COEXISTENCE: this project also serves the live primaddc.com website, whose
-- entire schema lives in `public`. Nothing in any IIMS migration may perform
-- DDL on public, auth or storage structures. The IIMS owns only the ten
-- schemas created here, and tracks its own migrations in config._migrations
-- (the website's runner uses public._migrations).

create schema if not exists iam;        -- identity, roles, permissions, clearance
create schema if not exists crm;        -- clients, engagements, intake, conflict checks
create schema if not exists casework;   -- cases, plans, tasks, activities, safety, finance
create schema if not exists intel;      -- entities, relationships, sources, information, findings
create schema if not exists evidence;   -- evidence items, files, custody, integrity
create schema if not exists docs;       -- folders, documents, versions, tags
create schema if not exists reporting;  -- reports, versions, sections, QA, deliveries
create schema if not exists audit;      -- append-only hash-chained audit and access log
create schema if not exists notify;     -- notifications, outbox, preferences, delivery
create schema if not exists config;     -- workflows, retention, legal holds, settings, AI

comment on schema audit is
  'Append-only. No UPDATE, DELETE or TRUNCATE privilege is ever granted to an '
  'application role, and triggers reject those operations. Corrections are '
  'added as new rows (PRD §13).';

-- Supabase installs extensions into the `extensions` schema. Every trigger
-- and index below pins an empty search_path for safety, so extension
-- functions must always be written schema-qualified as extensions.<fn>().
create extension if not exists pgcrypto      with schema extensions;  -- digest(), gen_random_uuid()
create extension if not exists pg_trgm       with schema extensions;  -- fuzzy conflict matching (§8.3)
create extension if not exists unaccent      with schema extensions;  -- name normalisation
create extension if not exists fuzzystrmatch with schema extensions;  -- dmetaphone phonetic keys
create extension if not exists citext        with schema extensions;  -- case-insensitive email
create extension if not exists btree_gin     with schema extensions;  -- composite search indexes

-- ---------------------------------------------------------------------------
-- unaccent() is STABLE, not IMMUTABLE, because it depends on a dictionary, so
-- Postgres refuses it in index expressions and generated columns. This wrapper
-- hard-codes the dictionary to make the promise explicit.
--
-- Caveat recorded in docs/architecture.md: IMMUTABLE is a promise, not a
-- check. If the dictionary ever changes, dependent indexes must be rebuilt.
-- ---------------------------------------------------------------------------
create or replace function config.immutable_unaccent(text)
  returns text
  language sql
  immutable
  parallel safe
  strict
  set search_path = ''
as $$
  select extensions.unaccent('extensions.unaccent', $1)
$$;

comment on function config.immutable_unaccent(text) is
  'IMMUTABLE wrapper over extensions.unaccent so accent-insensitive '
  'expressions can be indexed. Rebuild dependent indexes if the unaccent '
  'dictionary changes.';

-- ---------------------------------------------------------------------------
-- Migration ledger. Deliberately NOT public._migrations: the primaddc.com
-- runner owns that table and two runners sharing it would corrupt both
-- histories.
-- ---------------------------------------------------------------------------
create table if not exists config._migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);
