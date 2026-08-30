-- Defence in depth. `anon` still held UPDATE on every profiles column,
-- including plan and trial_started_at. RLS would refuse it (auth.uid() is null
-- for anon), so this was not exploitable — but a privilege that only a policy
-- stands between is one policy edit away from being a hole. Take it away.

revoke insert, update, delete on public.profiles from anon;
revoke insert, update, delete on public.ai_usage from anon;
revoke insert, update, delete on public.app_settings from anon;
