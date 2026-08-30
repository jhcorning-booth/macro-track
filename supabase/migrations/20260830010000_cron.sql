-- Scheduled jobs. Both call an Edge Function over pg_net and authenticate with
-- a shared secret held in Vault — the secret is never written into a migration
-- file. Set it once with:
--
--   npm run setup:cron
--
-- (which runs `supabase db query` to upsert `macrotrack_cron_secret` from
-- .env.local's CRON_SECRET).

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.call_edge_function(fn text)
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
    body    := '{}'::jsonb
  );
end;
$$;

revoke all on function public.call_edge_function(text) from public, anon, authenticated;

-- Nudges: every 15 minutes. Each one still fires at most once per user per
-- local day, and only when its condition actually holds, so this cadence just
-- gives every timezone a 15-minute resolution on its send_at.
select cron.unschedule('macrotrack-nudges')
  where exists (select 1 from cron.job where jobname = 'macrotrack-nudges');

select cron.schedule(
  'macrotrack-nudges',
  '*/15 * * * *',
  $$ select public.call_edge_function('send-nudges'); $$
);

-- Retention: once a day at 09:00 UTC (~04:00 America/Chicago), off-peak.
select cron.unschedule('macrotrack-retention')
  where exists (select 1 from cron.job where jobname = 'macrotrack-retention');

select cron.schedule(
  'macrotrack-retention',
  '0 9 * * *',
  $$ select public.call_edge_function('purge-retention'); $$
);
