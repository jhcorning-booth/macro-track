-- Trial limits. Signup is open, so every account can otherwise spend the
-- deployment's Anthropic key without bound. This caps that.
--
-- Enforcement lives in the database, not the app: consume_ai_credit() checks
-- and records in one SECURITY DEFINER call, so the check cannot be raced, and
-- ai_usage has no UPDATE or DELETE policy, so a user cannot reset their own
-- counter. The API route is a caller, not the authority.

create table if not exists public.app_settings (
  id                 boolean primary key default true check (id),
  trial_days         integer not null default 14  check (trial_days > 0),
  trial_analyses     integer not null default 150 check (trial_analyses > 0),
  contact_email      text    not null default 'jhcorning12@gmail.com',
  updated_at         timestamptz not null default now()
);

insert into public.app_settings (id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;
-- Readable by any signed-in user so the UI can show the real numbers;
-- writable only by the service role (no policy grants write).
create policy "settings readable" on public.app_settings
  for select to authenticated using (true);

comment on table public.app_settings is
  'Single-row knobs. Tune the trial without a migration, e.g. '
  'update public.app_settings set trial_days = 30, trial_analyses = 300;';

-- ----------------------------------------------------------------- plan

do $$ begin
  alter table public.profiles
    add column plan text not null default 'trial'
      check (plan in ('trial', 'paid', 'owner'));
exception when duplicate_column then null; end $$;

do $$ begin
  alter table public.profiles
    add column trial_started_at timestamptz not null default now();
exception when duplicate_column then null; end $$;

comment on column public.profiles.plan is
  'trial = time+quota limited · paid = unlimited, set by hand after someone '
  'gets in touch · owner = unlimited, the deployment owner.';

-- ------------------------------------------------------------ usage log

create table if not exists public.ai_usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  images     integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_user_idx on public.ai_usage (user_id, created_at desc);

alter table public.ai_usage enable row level security;

-- SELECT only. Deliberately no INSERT policy either: rows are written solely
-- by consume_ai_credit(), which is SECURITY DEFINER. And no UPDATE/DELETE, so
-- the quota counter cannot be rewound by the account it limits.
create policy "own usage readable" on public.ai_usage
  for select using (auth.uid() = user_id);

-- --------------------------------------------------------------- status

/** Read-only view of where an account stands. Used by the UI; the API relies
 *  on consume_ai_credit() instead so the check and the write are atomic. */
create or replace function public.trial_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_plan    text;
  v_started timestamptz;
  v_used    integer;
  s         public.app_settings;
  v_expires timestamptz;
  v_days    integer;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  select * into s from public.app_settings where id;
  select plan, trial_started_at into v_plan, v_started
    from public.profiles where id = v_user;

  if v_plan is null then
    v_plan := 'trial';
    v_started := now();
  end if;

  select count(*)::int into v_used from public.ai_usage where user_id = v_user;

  if v_plan <> 'trial' then
    return jsonb_build_object(
      'plan', v_plan, 'blocked', false, 'unlimited', true,
      'analyses_used', v_used, 'contact_email', s.contact_email
    );
  end if;

  v_expires := v_started + make_interval(days => s.trial_days);
  -- Ceil, so the final partial day still reads as "1 day left" not "0".
  v_days := greatest(0, ceil(extract(epoch from (v_expires - now())) / 86400.0)::int);

  return jsonb_build_object(
    'plan', 'trial',
    'unlimited', false,
    'blocked', (now() >= v_expires) or (v_used >= s.trial_analyses),
    'reason', case
                when now() >= v_expires then 'expired'
                when v_used >= s.trial_analyses then 'quota'
                else null end,
    'days_left', v_days,
    'trial_days', s.trial_days,
    'analyses_used', v_used,
    'analyses_limit', s.trial_analyses,
    'analyses_left', greatest(0, s.trial_analyses - v_used),
    'expires_at', v_expires,
    'contact_email', s.contact_email
  );
end;
$$;

-- -------------------------------------------------------------- consume

/** Atomically authorise one analysis and record it. Returns the same shape as
 *  trial_status(), with `allowed` telling the caller whether to proceed.
 *  Nothing is recorded when the answer is no. */
create or replace function public.consume_ai_credit(p_images integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_status jsonb;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  -- Serialise concurrent captures from the same account so two in flight
  -- cannot both pass the check on the last remaining credit.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));

  v_status := public.trial_status();

  if (v_status ->> 'blocked')::boolean then
    return v_status || jsonb_build_object('allowed', false);
  end if;

  insert into public.ai_usage (user_id, images)
  values (v_user, greatest(0, coalesce(p_images, 1)));

  return public.trial_status() || jsonb_build_object('allowed', true);
end;
$$;

revoke all on function public.consume_ai_credit(integer) from public, anon;
grant execute on function public.consume_ai_credit(integer) to authenticated;
revoke all on function public.trial_status() from public, anon;
grant execute on function public.trial_status() to authenticated;

-- The deployment owner is not on a trial.
update public.profiles p
   set plan = 'owner'
  from auth.users u
 where u.id = p.id
   and lower(u.email) = (select lower(contact_email) from public.app_settings where id);
