-- Durable, private AI report queue. Authenticated clients may only insert queued
-- work and read their own rows. All lifecycle mutations and atomic completion run
-- through the server-side service role.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  keys jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users manage their own profile" on public.profiles;
create policy "Users manage their own profile"
  on public.profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

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

drop policy if exists "Users manage their own reports" on public.saved_reports;
create policy "Users manage their own reports"
  on public.saved_reports for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists saved_reports_user_created
  on public.saved_reports (user_id, created_at desc);

-- Keep the server-owned report_job_id linkage out of browser writes while
-- preserving the existing saved-report CRUD surface.
revoke insert, update on public.saved_reports from authenticated;
grant select, delete on public.saved_reports to authenticated;
grant insert (
  user_id, address, county, parcel_id, acres, zoning_code, owner_name, report_markdown
) on public.saved_reports to authenticated;
grant update (
  address, county, parcel_id, acres, zoning_code, owner_name, report_markdown
) on public.saved_reports to authenticated;

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
  completed_at timestamptz,
  email_sent_at timestamptz
);

alter table public.report_jobs add column if not exists email_sent_at timestamptz;
alter table public.saved_reports add column if not exists report_job_id uuid;

do $$ begin
  alter table public.saved_reports
    add constraint saved_reports_report_job_fk
    foreign key (report_job_id) references public.report_jobs(id) on delete set null;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.report_jobs
    add constraint report_jobs_input_size
    check (octet_length(input_json::text) <= 500000);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.report_jobs
    add constraint report_jobs_address_size
    check (char_length(address) between 1 and 500);
exception when duplicate_object then null;
end $$;

create unique index if not exists saved_reports_report_job_unique
  on public.saved_reports (report_job_id)
  where report_job_id is not null;

create unique index if not exists report_jobs_one_active_per_user
  on public.report_jobs (user_id)
  where status in ('queued', 'running');

create index if not exists report_jobs_user_created
  on public.report_jobs (user_id, created_at desc);

create index if not exists report_jobs_queue_created
  on public.report_jobs (status, created_at asc);

create or replace function public.prepare_report_job_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recent_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if auth.uid() is null or new.user_id <> auth.uid() then
      raise exception 'A report job must belong to the authenticated user.';
    end if;
    if new.status <> 'queued' or new.saved_report_id is not null
       or new.started_at is not null or new.completed_at is not null
       or new.email_sent_at is not null or new.error_message is not null then
      raise exception 'Authenticated clients may only create queued report jobs.';
    end if;
    select count(*) into recent_count
      from public.report_jobs
      where user_id = auth.uid() and created_at >= now() - interval '24 hours';
    if recent_count >= 10 then
      raise exception 'Daily background report limit reached.';
    end if;
  end if;

  new.address := trim(coalesce(new.input_json #>> '{reportData,inputAddress}', ''));
  new.county := nullif(trim(coalesce(
    new.input_json #>> '{reportData,countyName}',
    new.input_json #>> '{reportData,county}',
    ''
  )), '');
  new.parcel_id := nullif(trim(coalesce(new.input_json #>> '{reportData,parcelId}', '')), '');
  new.zoning_code := nullif(trim(coalesce(new.input_json #>> '{reportData,zoningCode}', '')), '');
  new.owner_name := nullif(trim(coalesce(new.input_json #>> '{reportData,ownerName}', '')), '');
  if jsonb_typeof(new.input_json #> '{reportData,gisAcres}') = 'number' then
    new.acres := (new.input_json #>> '{reportData,gisAcres}')::double precision;
  else
    new.acres := null;
  end if;

  if char_length(new.address) not between 1 and 500
     or char_length(coalesce(new.county, '')) > 200
     or char_length(coalesce(new.parcel_id, '')) > 200
     or char_length(coalesce(new.zoning_code, '')) > 100
     or char_length(coalesce(new.owner_name, '')) > 300 then
    raise exception 'Report job metadata is invalid or too long.';
  end if;
  return new;
end;
$$;

drop trigger if exists prepare_report_job_insert on public.report_jobs;
create trigger prepare_report_job_insert
before insert on public.report_jobs
for each row execute function public.prepare_report_job_insert();
revoke all on function public.prepare_report_job_insert() from public, anon, authenticated;

alter table public.report_jobs enable row level security;
drop policy if exists "Users manage their own report jobs" on public.report_jobs;
drop policy if exists "Users read their own report jobs" on public.report_jobs;
drop policy if exists "Users queue their own report jobs" on public.report_jobs;

create policy "Users read their own report jobs"
  on public.report_jobs for select
  using (auth.uid() = user_id);

create policy "Users queue their own report jobs"
  on public.report_jobs for insert
  with check (
    auth.uid() = user_id
    and status = 'queued'
    and saved_report_id is null
    and started_at is null
    and completed_at is null
    and email_sent_at is null
    and error_message is null
  );

revoke all on public.report_jobs from anon;
revoke all on public.report_jobs from authenticated;
grant select, insert on public.report_jobs to authenticated;
grant all on public.report_jobs, public.saved_reports, public.profiles to service_role;

create or replace function public.complete_report_job(
  p_job_id uuid,
  p_report_markdown text
)
returns table (id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  job public.report_jobs%rowtype;
  report_id uuid;
begin
  select * into job from public.report_jobs where report_jobs.id = p_job_id for update;
  if not found then raise exception 'Report job was not found.'; end if;

  if job.status = 'completed' and job.saved_report_id is not null then
    return query select job.saved_report_id;
    return;
  end if;
  if job.status <> 'running' then
    raise exception 'Only a running report job can be completed.';
  end if;
  if p_report_markdown is null or char_length(trim(p_report_markdown)) < 100 then
    raise exception 'The completed report is empty or malformed.';
  end if;

  insert into public.saved_reports (
    user_id, address, county, parcel_id, acres, zoning_code, owner_name,
    report_markdown, report_job_id
  ) values (
    job.user_id, job.address, job.county, job.parcel_id, job.acres,
    job.zoning_code, job.owner_name, p_report_markdown, job.id
  )
  on conflict (report_job_id) where report_job_id is not null
  do update set report_markdown = excluded.report_markdown
  returning saved_reports.id into report_id;

  update public.report_jobs
    set status = 'completed', saved_report_id = report_id,
        completed_at = now(), error_message = null
    where report_jobs.id = job.id;

  return query select report_id;
end;
$$;

revoke all on function public.complete_report_job(uuid, text) from public, anon, authenticated;
grant execute on function public.complete_report_job(uuid, text) to service_role;
