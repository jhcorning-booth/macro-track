-- Operational error tracking, and the daily report that reads it.
--
-- Until now nothing in this app recorded a failure anywhere. A photo upload
-- that failed left `path: null` and carried on (app/api/analyze/route.ts:113);
-- an evidence insert that failed left `evidenceIds` empty, which quietly makes
-- the capture unretryable; a scheduled job that died at 04:00 died in silence.
-- None of it was visible without reading Vercel logs by hand.
--
-- Three properties this table is built around:
--
--   1. It is BUCKETED, one row per (day, source, code), not one row per event.
--      Rows are therefore bounded by distinct codes x days — about 50 a day at
--      worst — instead of by traffic. A crash-looping deploy updates a counter
--      rather than writing ten thousand rows and turning the daily mail into a
--      wall of identical lines.
--
--   2. It stores NO FREE TEXT. There is no message column and the write
--      function takes no message parameter. A user's note or transcript can
--      say anything ("two scoops at my mother's"), and this is operational
--      data about other people that gets posted to a third-party mail API
--      every morning; none of it belongs here. `code` is a closed allowlist,
--      so the report can only ever render strings this migration chose.
--      That also means an authenticated caller has no way to inject markup
--      into the owner's inbox — there is no attacker-controlled string to
--      inject with.
--
--   3. It cannot break the request that is reporting to it. See the exception
--      handler at the bottom of record_ops_event.

/* ------------------------------------------------------------------ table */

create table if not exists public.ops_events (
  event_day     date        not null,
  source        text        not null
                check (source in ('api_analyze','api_push','edge_nudges','edge_retention')),
  code          text        not null
                check (code in (
                  -- api_analyze
                  'credit_rpc_failed',      -- the quota RPC itself errored
                  'photo_upload_failed',    -- storage rejected the image; the photo is gone
                  'evidence_insert_failed', -- no evidence row, so Try again cannot work
                  'evidence_link_failed',   -- orphaned evidence; retention deletes it in 2 days
                  'model_failed',           -- the analysis threw: model, parse, or network
                  'no_entries_returned',    -- model succeeded but found no food
                  'entry_insert_failed',    -- the food_entries write failed
                  'nothing_to_analyze',     -- no photo, no note, no transcript
                  'retry_evidence_missing', -- Try again pointed at evidence that is gone
                  -- api_push
                  'push_subscribe_failed',
                  -- scheduled jobs
                  'job_failed'
                )),
  -- 'warn' is a thing the user did (an empty capture); 'error' is a thing that
  -- broke. Only 'error' turns the subject line red — a report that cries wolf
  -- over ordinary user behaviour stops being read within a week.
  severity      text        not null default 'error' check (severity in ('error','warn')),
  occurrences   integer     not null default 0,
  -- Capped sample of affected accounts, so the report can say "3 people" and
  -- the owner can go and look. Capped so one bad day cannot grow the row.
  users         uuid[]      not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- Set once the "a new kind of error appeared" mail has gone out, so the
  -- 15-minute alert job never sends the same news twice.
  alerted_at    timestamptz,
  primary key (event_day, source, code)
);

comment on table public.ops_events is
  'Bucketed operational failures, one row per day/source/code. Written only by '
  'record_ops_event(); read only by ops_report(). Deliberately holds no free '
  'text — see the migration header.';

create index if not exists ops_events_alert_idx
  on public.ops_events (alerted_at, last_seen_at desc)
  where alerted_at is null;

alter table public.ops_events enable row level security;

-- No policies at all, deliberately. RLS with zero policies denies every
-- client read and write. The only paths in are the two SECURITY DEFINER
-- functions below, and the service role (which bypasses RLS) inside the
-- Edge Functions.

/* ------------------------------------------------------------ rate guard */

-- record_ops_event has to be granted to `authenticated`: the API routes run as
-- the signed-in user (lib/supabase/server.ts), and the service-role key is
-- deliberately absent from the web host. The closed `code` allowlist already
-- bounds how many ROWS a caller can create, but nothing would stop one account
-- hammering the RPC and generating row-lock contention and dead tuples on a
-- single hot bucket. This bounds the rate as well as the cardinality.
create table if not exists public.ops_event_rate (
  user_id     uuid        not null references auth.users on delete cascade,
  hour_bucket timestamptz not null,
  calls       integer     not null default 0,
  primary key (user_id, hour_bucket)
);

alter table public.ops_event_rate enable row level security;

/* --------------------------------------------------------------- writing */

create or replace function public.record_ops_event(
  p_source   text,
  p_code     text,
  p_severity text default 'error'
)
returns void
language plpgsql
security definer
-- Empty, not `public`. supabase/migrations/20260830020000_harden.sql:12
-- established this as the standard here: every reference below is already
-- schema-qualified, so pinning it to '' costs nothing and removes the whole
-- question of what `authenticated` might be able to create in `public`.
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_hour  timestamptz := date_trunc('hour', now());
  v_calls integer;
begin
  if v_user is not null then
    insert into public.ops_event_rate (user_id, hour_bucket, calls)
         values (v_user, v_hour, 1)
    on conflict (user_id, hour_bucket)
      do update set calls = public.ops_event_rate.calls + 1
      returning calls into v_calls;

    -- Generous next to real traffic (a busy day is a few dozen analyses) and
    -- still a hard ceiling on abuse. Silently ignored rather than raised: the
    -- caller is an error handler and must not be given a new error.
    if v_calls > 120 then
      return;
    end if;
  end if;

  insert into public.ops_events as e (
    event_day, source, code, severity, occurrences, users
  )
  values (
    (now() at time zone 'America/Chicago')::date,
    p_source, p_code, coalesce(p_severity, 'error'), 1,
    case when v_user is null then '{}'::uuid[] else array[v_user] end
  )
  on conflict (event_day, source, code) do update
    set occurrences  = e.occurrences + 1,
        last_seen_at = now(),
        -- Distinct, and capped at 20: the report only needs "how many, and a
        -- few to go look at", and an uncapped array is an unbounded column.
        users = case
                  when v_user is null or v_user = any(e.users) then e.users
                  when array_length(e.users, 1) >= 20 then e.users
                  else e.users || v_user
                end;

exception
  -- The single most important line in this migration. This function is called
  -- from inside catch blocks. If the table is missing, if a CHECK rejects an
  -- unknown code, if RLS or a grant is wrong, if the disk is full — the caller
  -- must be completely unaffected. A telemetry failure turning a handled
  -- analysis error into an unhandled 500 would be strictly worse than having
  -- no telemetry at all.
  when others then
    return;
end;
$$;

revoke all on function public.record_ops_event(text, text, text) from public, anon;
grant execute on function public.record_ops_event(text, text, text) to authenticated, service_role;

/* --------------------------------------------------------------- reading */

-- Indexes for the report's date windows. Every existing index on these tables
-- leads with user_id (init.sql:101, :134, :119; trial_limits.sql:55) and the
-- report filters by date with no user predicate, so without these it is four
-- sequential scans. Free at ten users; the difference between a 20 ms report
-- and a statement timeout at a thousand.
create index if not exists food_entries_created_idx  on public.food_entries  (created_at desc);
create index if not exists weight_entries_created_idx on public.weight_entries (created_at desc);
create index if not exists ai_usage_created_idx      on public.ai_usage      (created_at desc);

create or replace function public.ops_report(p_day date default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with cfg as (
    select
      coalesce(p_day, (now() at time zone 'America/Chicago')::date - 1) as day
  ),
  w as (
    -- The report day as a half-open UTC range. Built from a naive timestamp so
    -- the America/Chicago conversion is explicit and survives a DST change;
    -- date_trunc on a bare date would silently pick the timestamptz overload
    -- and truncate in the session timezone instead.
    select
      c.day,
      (c.day::timestamp                       at time zone 'America/Chicago') as t0,
      ((c.day + 1)::timestamp                 at time zone 'America/Chicago') as t1,
      ((c.day - 6)::timestamp                 at time zone 'America/Chicago') as t7,
      (date_trunc('month', c.day::timestamp)  at time zone 'America/Chicago') as tm
    from cfg c
  ),

  /* ------------------------------------------------------- people */
  signups as (
    select coalesce(jsonb_agg(x order by x->>'at'), '[]'::jsonb) as v
    from (
      select jsonb_build_object(
               'email', u.email,
               'at',    to_char(u.created_at at time zone 'America/Chicago', 'HH24:MI'),
               'logged', (select count(*) from public.food_entries f where f.user_id = u.id)
             ) as x
      from auth.users u, w
      where u.created_at >= w.t0 and u.created_at < w.t1
      limit 10
    ) s
  ),
  stalled as (
    -- Signed up in the last 7 days and has never logged anything. Ages out
    -- rather than accumulating into a permanent graveyard the owner skims past.
    select coalesce(jsonb_agg(x), '[]'::jsonb) as v
    from (
      select jsonb_build_object(
               'email', u.email,
               'days',  extract(day from (w.t1 - u.created_at))::int
             ) as x
      from auth.users u, w
      where u.created_at < w.t0
        and u.created_at >= w.t7
        and not exists (select 1 from public.food_entries f where f.user_id = u.id)
      limit 10
    ) s
  ),
  roster as (
    -- Who was active, one line each. At this scale the roster is strictly more
    -- informative than any count computed from it. Deliberately no calorie or
    -- weight figures: that is the user's business, not the operator's, and it
    -- would be posted to a third-party mail API every morning for no
    -- operational gain.
    select coalesce(jsonb_agg(x order by (x->>'analyses')::int desc), '[]'::jsonb) as v
    from (
      select jsonb_build_object(
               'email',    u.email,
               'entries',  (select count(*) from public.food_entries f, w
                             where f.user_id = u.id and f.created_at >= w.t0 and f.created_at < w.t1),
               'byHand',   (select count(*) from public.food_entries f, w
                             where f.user_id = u.id and f.created_at >= w.t0 and f.created_at < w.t1
                               and f.source_type in ('manual','quick_add','history_readd')),
               'analyses', (select count(*) from public.ai_usage a, w
                             where a.user_id = u.id and a.created_at >= w.t0 and a.created_at < w.t1)
             ) as x
      from auth.users u
      where exists (select 1 from public.ai_usage a, w
                     where a.user_id = u.id and a.created_at >= w.t0 and a.created_at < w.t1)
         or exists (select 1 from public.food_entries f, w
                     where f.user_id = u.id and f.created_at >= w.t0 and f.created_at < w.t1)
      limit 25
    ) r
  ),
  trials as (
    -- days_left measured against now() and clamped at zero, exactly as
    -- trial_status() does (trial_limits.sql:108), so the email and the in-app
    -- wall can never disagree about whether someone has run out.
    select coalesce(jsonb_agg(x), '[]'::jsonb) as v
    from (
      select jsonb_build_object(
               'email', u.email,
               'daysLeft', greatest(0, ceil(extract(epoch from
                   ((p.trial_started_at + make_interval(days => s.trial_days)) - now())) / 86400.0)::int),
               'used', (select count(*) from public.ai_usage a where a.user_id = u.id),
               'limit', s.trial_analyses
             ) as x
      from public.profiles p
      join auth.users u on u.id = p.id
      cross join public.app_settings s
      where p.plan = 'trial'
        and (
          (p.trial_started_at + make_interval(days => s.trial_days)) - now() < interval '3 days'
          or (select count(*) from public.ai_usage a where a.user_id = u.id) >= s.trial_analyses * 0.8
        )
      limit 10
    ) t
  ),

  /* -------------------------------------------------------- usage */
  usage as (
    select
      (select count(*)              from public.ai_usage a, w where a.created_at >= w.t0 and a.created_at < w.t1) as analyses,
      (select coalesce(sum(greatest(a.images,1)),0) from public.ai_usage a, w where a.created_at >= w.t0 and a.created_at < w.t1) as images,
      (select count(distinct a.user_id) from public.ai_usage a, w where a.created_at >= w.t0 and a.created_at < w.t1) as active,
      (select count(*)              from public.food_entries f, w where f.created_at >= w.t0 and f.created_at < w.t1) as entries,
      (select coalesce(sum(greatest(a.images,1)),0) from public.ai_usage a, w where a.created_at >= w.t7 and a.created_at < w.t1) as images_7d,
      (select coalesce(sum(greatest(a.images,1)),0) from public.ai_usage a, w where a.created_at >= w.tm and a.created_at < w.t1) as images_mtd,
      (select count(*) from public.ai_usage a, w where a.created_at >= w.t7 and a.created_at < w.t1) as calls_7d,
      (select count(*) from public.ai_usage a, w where a.created_at >= w.tm and a.created_at < w.t1) as calls_mtd
  ),
  sources as (
    select coalesce(jsonb_object_agg(source_type, n), '{}'::jsonb) as v
    from (
      select f.source_type, count(*) as n
      from public.food_entries f, w
      where f.created_at >= w.t0 and f.created_at < w.t1
      group by f.source_type
    ) s
  ),

  /* ------------------------------------------------------ errors */
  events as (
    select coalesce(jsonb_agg(x order by (x->>'count')::int desc), '[]'::jsonb) as v
    from (
      select jsonb_build_object(
               'source',   e.source,
               'code',     e.code,
               'severity', e.severity,
               'count',    e.occurrences,
               'users',    coalesce(array_length(e.users, 1), 0),
               'last',     to_char(e.last_seen_at at time zone 'America/Chicago', 'HH24:MI')
             ) as x
      from public.ops_events e, w
      where e.event_day = w.day
      order by e.occurrences desc
      limit 15
    ) v
  ),
  totals as (
    select
      (select count(*) from auth.users) as users_total,
      (select count(distinct f.user_id) from public.food_entries f) as users_logged,
      -- Only real errors count toward the headline. Trial walls and empty
      -- captures are not failures and must never turn the subject line red.
      (select coalesce(sum(e.occurrences),0)::int
         from public.ops_events e, w
        where e.event_day = w.day and e.severity = 'error') as errors
  )

  select jsonb_build_object(
    'day',      (select day from w),
    'people',   jsonb_build_object(
                  'signups', (select v from signups),
                  'stalled', (select v from stalled),
                  'trials',  (select v from trials),
                  'total',   (select users_total from totals),
                  'logged',  (select users_logged from totals)
                ),
    'usage',    jsonb_build_object(
                  'analyses',   (select analyses from usage),
                  'images',     (select images from usage),
                  'active',     (select active from usage),
                  'entries',    (select entries from usage),
                  'images7d',   (select images_7d from usage),
                  'imagesMtd',  (select images_mtd from usage),
                  'calls7d',    (select calls_7d from usage),
                  'callsMtd',   (select calls_mtd from usage),
                  'sources',    (select v from sources),
                  'roster',     (select v from roster)
                ),
    'errors',   jsonb_build_object(
                  'total',  (select errors from totals),
                  'events', (select v from events)
                )
  );
$$;

-- The report contains every registered user's email address. It is readable by
-- the Edge Function's service role and by nothing else. The explicit grant
-- matters: no migration in this repo has ever granted anything to service_role
-- (both existing Edge Functions reach tables via .from(), which works because
-- service_role has BYPASSRLS), so relying on a default privilege here would be
-- betting the feature on an unverified assumption.
revoke all on function public.ops_report(date) from public, anon, authenticated;
grant execute on function public.ops_report(date) to service_role;
