-- Durable AI report queue. Netlify background workers process rows while RLS
-- keeps job input, status, and completed reports private to the account.
-- The supporting account/report tables are repeated with IF NOT EXISTS because
-- older installs created them manually from SETUP_SUPABASE.md rather than from a
-- migration; this also makes a fresh `supabase db push` self-contained.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  keys jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

do $$ begin
  create policy "Users manage their own profile"
    on public.profiles for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

create table if not exists public.saved_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  address text not null,
  county text,
  parcel_id text,
  acres double precision,
  zoning_code text,
  owner_name text,
  report_markdown text not null,
  created_at timestamptz not null default now()
);

alter table public.saved_reports enable row level security;

do $$ begin
  create policy "Users manage their own reports"
    on public.saved_reports for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

create index if not exists saved_reports_user_created
  on public.saved_reports (user_id, created_at desc);

create table if not exists public.report_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  email_when_done boolean not null default false,
  address text not null,
  county text,
  parcel_id text,
  acres double precision,
  zoning_code text,
  owner_name text,
  input_json jsonb not null,
  saved_report_id uuid references public.saved_reports(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

alter table public.report_jobs enable row level security;

do $$ begin
  create policy "Users manage their own report jobs"
    on public.report_jobs for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

create index if not exists report_jobs_user_created
  on public.report_jobs (user_id, created_at desc);
