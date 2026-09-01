-- Schedules the daily report and the new-error alert.
--
-- call_edge_function() posted a fixed '{}' body (20260830010000_cron.sql:37),
-- which was fine when every job did exactly one thing. The report function has
-- two modes, so the body has to be passable. The parameter defaults to '{}',
-- so the two existing schedules keep working untouched.

create or replace function public.call_edge_function(fn text, payload jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'macrotrack_cron_secret';

  if v_secret is null then
    raise warning 'macrotrack_cron_secret is not set in Vault; skipping %', fn;
    return;
  end if;

  perform net.http_post(
    url     := 'https://tzykugpyzsfqrgllkdih.supabase.co/functions/v1/' || fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secret
    ),
    body    := coalesce(payload, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.call_edge_function(text, jsonb) from public, anon, authenticated;

-- The morning report: 12:00 UTC, which is 07:00 in America/Chicago on daylight
-- time and 06:00 on standard time. It reports on YESTERDAY (ops_report's
-- default), so it is never racing a day that is still in progress.
select cron.unschedule('macrotrack-daily-report')
  where exists (select 1 from cron.job where jobname = 'macrotrack-daily-report');

select cron.schedule(
  'macrotrack-daily-report',
  '0 12 * * *',
  $$ select public.call_edge_function('daily-report', '{"mode":"daily"}'::jsonb); $$
);

-- New-error alerts: every 15 minutes, and silent unless a kind of error that
-- has never been alerted on shows up. This is what lets the daily mail be a
-- digest rather than an alarm — anything genuinely new arrives within the
-- quarter hour, so a quiet morning report can be skimmed without risk.
select cron.unschedule('macrotrack-error-alert')
  where exists (select 1 from cron.job where jobname = 'macrotrack-error-alert');

select cron.schedule(
  'macrotrack-error-alert',
  '*/15 * * * *',
  $$ select public.call_edge_function('daily-report', '{"mode":"alert"}'::jsonb); $$
);
