-- Astra Gateway — Supabase Postgres schema
-- Run in Supabase SQL Editor.

create table if not exists public.api_keys (
  id text primary key,
  key_secret text unique not null,
  name text not null,
  status text not null,
  token_limit bigint not null,
  tokens_used bigint not null default 0,
  requests bigint not null default 0,
  models_used text not null default '',
  allowed_models text,
  created_at text not null,
  expires_at text,
  last_used_at text
);

create table if not exists public.models (
  id text primary key,
  upstream_id text not null,
  label text not null,
  enabled boolean not null default true,
  system_prompt text,
  hide_thinking boolean not null default false,
  response_delay_ms integer not null default 0,
  supports_vision boolean not null default false,
  ensemble_enabled boolean not null default false,
  ensemble_members text,
  ensemble_strategy text,
  created_at text not null
);

create table if not exists public.meta (
  k text primary key,
  total_requests bigint not null default 0,
  total_tokens bigint not null default 0,
  started_at text
);

create table if not exists public.usage_days (
  day text primary key,
  requests bigint not null default 0,
  tokens bigint not null default 0
);

create table if not exists public.request_log (
  id text primary key,
  key_id text not null,
  at text not null,
  model text,
  status integer not null,
  tokens bigint not null default 0,
  duration_ms integer not null default 0,
  error text
);

alter table public.api_keys add column if not exists allowed_models text;
alter table public.models add column if not exists system_prompt text;
alter table public.models add column if not exists hide_thinking boolean not null default false;
alter table public.models add column if not exists response_delay_ms integer not null default 0;
alter table public.models add column if not exists supports_vision boolean not null default false;
alter table public.models add column if not exists ensemble_enabled boolean not null default false;
alter table public.models add column if not exists ensemble_members text;
alter table public.models add column if not exists ensemble_strategy text;

insert into public.meta (k, total_requests, total_tokens, started_at)
values ('stats', 0, 0, now()::text)
on conflict (k) do nothing;

create index if not exists idx_api_keys_key_secret on public.api_keys (key_secret);
create index if not exists idx_request_log_key_id on public.request_log (key_id);
create index if not exists idx_request_log_at on public.request_log (at);
create index if not exists idx_models_enabled on public.models (enabled);
