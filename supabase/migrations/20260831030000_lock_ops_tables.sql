-- Same reasoning as 20260830080000_lock_anon_writes.sql, applied to the new
-- operations tables. RLS is enabled on both with no policies, so every client
-- read already returns zero rows and every write is refused — verified against
-- the live API. But `anon` and `authenticated` still hold the default table
-- grants Supabase issues on the public schema, and a privilege that only a
-- policy stands between is one policy edit away from being a hole.
--
-- ops_events holds failure counts across every account, and ops_event_rate
-- maps user ids to activity hours. Neither is any client's business. The only
-- paths in stay record_ops_event() and ops_report(), both SECURITY DEFINER,
-- plus the service role inside the Edge Functions.

revoke all on public.ops_events     from anon, authenticated;
revoke all on public.ops_event_rate from anon, authenticated;
