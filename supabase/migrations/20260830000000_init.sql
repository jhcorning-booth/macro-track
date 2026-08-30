-- MacroTrack AI — core schema
-- Single-user-per-account model: every row is scoped by user_id and guarded by RLS.
-- The app performs all arithmetic (PRD §16, §36); the DB stores per-item structured values
-- and derives day-level aggregates in a view so nothing has to be kept in sync by hand.

create extension if not exists pg_trgm;
create extension if not exists btree_gist;

-- ---------------------------------------------------------------- profiles

create table public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  timezone     text        not null default 'America/Chicago',
  weight_unit  text        not null default 'lb' check (weight_unit in ('lb','kg')),
  goal_label   text        not null default 'lean bulk',
  onboarded_at timestamptz,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------- nutrition targets
-- Versioned (PRD §6.2). A day is always scored against the target that was
-- active on that date, so editing targets never rewrites history.
-- effective_to null = "current, open-ended".

create table public.nutrition_targets (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  calories_target integer      not null check (calories_target > 0),
  protein_target_g numeric(6,1) not null check (protein_target_g >= 0),
  carbs_target_g   numeric(6,1) not null check (carbs_target_g   >= 0),
  fat_target_g     numeric(6,1) not null check (fat_target_g     >= 0),
  effective_from  date not null,
  effective_to    date,
  created_at      timestamptz not null default now(),
  constraint nutrition_targets_range_valid
    check (effective_to is null or effective_to >= effective_from),
  -- one target version per user per day, no gaps caused by overlap
  constraint nutrition_targets_no_overlap
    exclude using gist (
      user_id with =,
      daterange(effective_from, effective_to, '[]') with &&
    )
);

create index nutrition_targets_user_from_idx
  on public.nutrition_targets (user_id, effective_from desc);

-- ------------------------------------------------------------- saved foods
-- Personal food memory (PRD §22). Matched by barcode, then trigram name
-- similarity, before any AI inference is attempted.

create table public.saved_foods (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  name         text not null,
  calories     numeric(8,1) not null default 0,
  protein_g    numeric(7,1) not null default 0,
  carbs_g      numeric(7,1) not null default 0,
  fat_g        numeric(7,1) not null default 0,
  serving_size text,
  barcode      text,
  times_logged integer     not null default 1,
  last_used    timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index saved_foods_user_idx      on public.saved_foods (user_id, last_used desc);
create index saved_foods_name_trgm_idx on public.saved_foods using gin (name gin_trgm_ops);
create unique index saved_foods_barcode_idx
  on public.saved_foods (user_id, barcode) where barcode is not null;

-- ------------------------------------------------------------ food entries
-- calories/protein_g/carbs_g/fat_g are ALWAYS the consumed totals for this
-- entry — what counts toward the day. quantity/unit are descriptive ("2
-- scoops") and travel with the entry for provenance and re-editing.

create table public.food_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  local_date    date not null,
  consumed_at   timestamptz not null default now(),
  name          text not null,
  calories      numeric(8,1) not null default 0 check (calories  >= 0),
  protein_g     numeric(7,1) not null default 0 check (protein_g >= 0),
  carbs_g       numeric(7,1) not null default 0 check (carbs_g   >= 0),
  fat_g         numeric(7,1) not null default 0 check (fat_g     >= 0),
  quantity      numeric(8,2) not null default 1,
  unit          text,
  source_type   text not null default 'manual'
                check (source_type in ('nutrition_label','saved_food','food_database',
                                       'visual_estimate','text_only','manual','quick_add','history_readd')),
  confidence    text not null default 'medium' check (confidence in ('high','medium','low')),
  source_label  text,           -- "Nutrition label + your note" — shown under the name in the edit sheet
  reasoning     text,           -- plain-language explanation for the reasoning card
  notes         text,
  saved_food_id uuid references public.saved_foods on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index food_entries_user_date_idx on public.food_entries (user_id, local_date desc, consumed_at);
create index food_entries_name_trgm_idx on public.food_entries using gin (name gin_trgm_ops);

-- ---------------------------------------------------------- food evidence
-- Original inputs are preserved so a failed pipeline run can be retried
-- without the user re-photographing anything (PRD §37).

create table public.food_evidence (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  food_entry_id   uuid references public.food_entries on delete cascade,
  image_path      text,          -- object path inside the `food-photos` bucket
  text_input      text,
  voice_transcript text,
  created_at      timestamptz not null default now()
);

create index food_evidence_entry_idx on public.food_evidence (food_entry_id);
create index food_evidence_user_idx  on public.food_evidence (user_id, created_at desc);

-- ----------------------------------------------------------- weight entries

create table public.weight_entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  local_date date not null,
  weight     numeric(6,2) not null check (weight > 0),
  unit       text not null default 'lb' check (unit in ('lb','kg')),
  notes      text,
  created_at timestamptz not null default now(),
  unique (user_id, local_date)
);

create index weight_entries_user_date_idx on public.weight_entries (user_id, local_date desc);

-- ------------------------------------------------------ notification prefs
-- One row per nudge kind so per-notification time pickers need no migration.

create table public.notification_prefs (
  user_id uuid not null references auth.users on delete cascade,
  kind    text not null check (kind in ('no_logging','calories_remaining',
                                        'target_reached','protein_checkin','evening_nudge')),
  enabled boolean not null default true,
  send_at time    not null default '10:00',
  primary key (user_id, kind)
);

create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Dedupe guard: a given nudge fires at most once per local day.
create table public.notification_log (
  user_id    uuid not null references auth.users on delete cascade,
  kind       text not null,
  local_date date not null,
  sent_at    timestamptz not null default now(),
  primary key (user_id, kind, local_date)
);

-- ------------------------------------------------------------------ views
-- daily_logs is derived, never written. Each day carries the target that was
-- in force on that date, so history is stable across target edits.

create or replace view public.daily_logs
with (security_invoker = on) as
with days as (
  select user_id, local_date from public.food_entries
  union
  select user_id, local_date from public.weight_entries
),
agg as (
  select
    d.user_id,
    d.local_date,
    coalesce(sum(e.calories),  0)::numeric(10,1) as total_calories,
    coalesce(sum(e.protein_g), 0)::numeric(9,1)  as total_protein_g,
    coalesce(sum(e.carbs_g),   0)::numeric(9,1)  as total_carbs_g,
    coalesce(sum(e.fat_g),     0)::numeric(9,1)  as total_fat_g,
    count(e.id)                                  as entry_count
  from days d
  left join public.food_entries e
    on e.user_id = d.user_id and e.local_date = d.local_date
  group by d.user_id, d.local_date
)
select
  a.user_id,
  a.local_date,
  a.total_calories,
  a.total_protein_g,
  a.total_carbs_g,
  a.total_fat_g,
  a.entry_count,
  t.calories_target,
  t.protein_target_g,
  t.carbs_target_g,
  t.fat_target_g,
  (t.calories_target is not null and a.total_calories >= t.calories_target) as calorie_goal_achieved,
  w.weight,
  w.unit as weight_unit
from agg a
left join lateral (
  select nt.calories_target, nt.protein_target_g, nt.carbs_target_g, nt.fat_target_g
  from public.nutrition_targets nt
  where nt.user_id = a.user_id
    and nt.effective_from <= a.local_date
    and (nt.effective_to is null or nt.effective_to >= a.local_date)
  order by nt.effective_from desc
  limit 1
) t on true
left join public.weight_entries w
  on w.user_id = a.user_id and w.local_date = a.local_date;

-- --------------------------------------------------------------- functions

-- Re-target from a given date forward without touching history (PRD §6.2).
create or replace function public.set_targets_from(
  p_from     date,
  p_calories integer,
  p_protein  numeric,
  p_carbs    numeric,
  p_fat      numeric
) returns public.nutrition_targets
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_row  public.nutrition_targets;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  -- Drop any versions that start on or after p_from; they are being replaced.
  delete from public.nutrition_targets
   where user_id = v_user and effective_from >= p_from;

  -- Close the version that spans p_from.
  update public.nutrition_targets
     set effective_to = p_from - 1
   where user_id = v_user
     and effective_from < p_from
     and (effective_to is null or effective_to >= p_from);

  -- Remove a version that just collapsed to an empty range.
  delete from public.nutrition_targets
   where user_id = v_user and effective_to is not null and effective_to < effective_from;

  insert into public.nutrition_targets
    (user_id, calories_target, protein_target_g, carbs_target_g, fat_target_g, effective_from, effective_to)
  values (v_user, p_calories, p_protein, p_carbs, p_fat, p_from, null)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger food_entries_touch
  before update on public.food_entries
  for each row execute function public.touch_updated_at();

-- New account: profile, default targets, default nudge prefs.
create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;

  insert into public.nutrition_targets
    (user_id, calories_target, protein_target_g, carbs_target_g, fat_target_g, effective_from)
  values (new.id, 2850, 200, 300, 80, current_date)
  on conflict do nothing;

  insert into public.notification_prefs (user_id, kind, enabled, send_at) values
    (new.id, 'no_logging',         true,  '10:00'),
    (new.id, 'calories_remaining', true,  '15:00'),
    (new.id, 'target_reached',     false, '21:00'),
    (new.id, 'protein_checkin',    true,  '17:00'),
    (new.id, 'evening_nudge',      true,  '20:00')
  on conflict do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------- RLS

alter table public.profiles           enable row level security;
alter table public.nutrition_targets  enable row level security;
alter table public.saved_foods        enable row level security;
alter table public.food_entries       enable row level security;
alter table public.food_evidence      enable row level security;
alter table public.weight_entries     enable row level security;
alter table public.notification_prefs enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_log   enable row level security;

create policy "own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "own targets" on public.nutrition_targets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own saved foods" on public.saved_foods
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own entries" on public.food_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own evidence" on public.food_evidence
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own weights" on public.weight_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own notif prefs" on public.notification_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own push subs" on public.push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own notif log" on public.notification_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------- storage
-- Private bucket. Objects live at <user_id>/<entry-or-batch>/<file>, so the
-- first path segment is the ownership check.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('food-photos', 'food-photos', false, 15728640,
        array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;

create policy "own photos read" on storage.objects
  for select using (bucket_id = 'food-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own photos write" on storage.objects
  for insert with check (bucket_id = 'food-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own photos update" on storage.objects
  for update using (bucket_id = 'food-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own photos delete" on storage.objects
  for delete using (bucket_id = 'food-photos' and (storage.foldername(name))[1] = auth.uid()::text);
