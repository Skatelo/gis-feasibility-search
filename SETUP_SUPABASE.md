# Supabase Setup (Cloud Accounts, Real Google Sign-In, Synced Reports)

One-time setup, about 10 minutes. After this, accounts, API keys, and saved
reports live in YOUR Supabase project (free tier is fine) and sync across
devices. Until Supabase is connected, the app runs in local-only fallback mode.

## 1. Create the project

1. Go to https://supabase.com → sign in → **New project** (any name, e.g. `gis-feasibility`).
2. When it finishes provisioning, open **Settings → API** and copy:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon / public key**

## 2. Create the tables (copy–paste)

Open **SQL Editor** in the Supabase dashboard, paste ALL of this, and click **Run**:

```sql
-- Per-user profile: stores each account's own API keys
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  keys jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users manage their own profile"
  on public.profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Saved feasibility reports, one row per saved report
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

create policy "Users manage their own reports"
  on public.saved_reports for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists saved_reports_user_created
  on public.saved_reports (user_id, created_at desc);

-- Comp run history: one row per comp search, plus its verified listings
create table if not exists public.comp_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_at timestamptz not null default now(),
  target_address text not null,
  target_lat double precision,
  target_lng double precision,
  zips_searched text,
  zips_skipped text,
  radius_miles double precision,
  radius_expanded boolean default false,
  comp_count int,
  avg_sold_price double precision,
  avg_price_per_sqft double precision,
  summary_md text
);

alter table public.comp_runs enable row level security;

create policy "Users manage their own comp runs"
  on public.comp_runs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.comp_listings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.comp_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  address text,
  zip text,
  driving_miles double precision,
  straight_line_miles double precision,
  driving_distance_fallback boolean default false,
  sold_price double precision,
  sold_date text,
  living_area_sqft double precision,
  price_per_sqft double precision,
  lat double precision,
  lng double precision,
  url text,
  verified_note text,
  price_discrepancy text,
  sources text default 'Realtor'
);

alter table public.comp_listings enable row level security;

create policy "Users manage their own comp listings"
  on public.comp_listings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists comp_runs_user_run_at
  on public.comp_runs (user_id, run_at desc);

-- Cross-device sync for Land Assistant chat history + GIS search history.
-- A generic per-user key/value store (one row per key, e.g. 'chat_conversations',
-- 'search_history'); the whole blob is written on each change.
create table if not exists public.user_sync (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.user_sync enable row level security;

create policy "Users manage their own sync data"
  on public.user_sync for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

Row Level Security means each signed-in user can only ever see their own
profile, keys, and reports — even though the app uses the public anon key.

> **Already ran the earlier setup?** Just paste and run the **`user_sync`** block
> above (it's `create table if not exists`, so re-running the rest is harmless) to
> turn on cross-device sync of your Land Assistant chats and GIS search history.

## 3. Enable REAL Google Sign-In

1. In **Google Cloud Console** (https://console.cloud.google.com):
   - APIs & Services → Credentials → **Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Under **Authorized redirect URIs** add your Supabase callback:
     `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
     (shown verbatim in the Supabase Google provider screen — copy it from there.)
   - Save, and copy the **Client ID** and **Client Secret**.
2. In **Supabase dashboard**: Authentication → **Sign In / Providers** → **Google**:
   - Toggle **Enable**, paste the Client ID and Client Secret, save.
3. In Supabase: Authentication → **URL Configuration**:
   - Set **Site URL** to where the app runs (e.g. `http://localhost:5173` during
     development). Add your production URL to **Redirect URLs** when you deploy.

## 4. (Recommended) Email confirmation

By default Supabase requires new email/password accounts to confirm via email.
Keep it on for real use, or turn it off for instant sign-ups:
Authentication → Sign In / Providers → Email → toggle **Confirm email**.

## 5. Connect the app

Either option works:

**Option A — paste in the app (easiest):** on the sign-in screen click
**"Connect Supabase"**, paste the Project URL and anon key, click Connect.

**Option B — .env.local:** add to `.env.local` in the project root:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

then restart `npm run dev`.

## What you get once connected

- **Sign Up / Sign In** with real email + password accounts (Supabase Auth).
- **Sign In with Google** — the real Google account chooser, via OAuth.
- **Remember me** — checked: stays signed in across restarts; unchecked: the
  session ends when the browser closes.
- **API keys** (Google Maps, Gemini, OpenTopography, RealtyAPI) saved to your
  account profile and synced to any device you sign in on.
- **Saved reports** stored in the cloud per account — save on one machine,
  open and download as PDF on another.

## Troubleshooting

- *Google button errors with "provider is not enabled"* → step 3.2 wasn't saved.
- *Google redirects but you land signed-out* → the app's URL isn't in
  Authentication → URL Configuration → Site URL / Redirect URLs.
- *"Could not load your reports"* → the SQL in step 2 hasn't been run.
- *Sign-up says "check your email" but nothing arrives* → check spam, or
  disable Confirm email (step 4).
