-- 20260831040000 added call_edge_function(text, jsonb default '{}') so the
-- report job could pass a mode. It did not drop the original
-- call_edge_function(text), so BOTH overloads existed and the one-argument
-- form used by the two pre-existing schedules became ambiguous:
--
--   ERROR: 42725: function public.call_edge_function(unknown) is not unique
--
-- pg_cron records a job failure and moves on, so macrotrack-nudges and
-- macrotrack-retention would simply have stopped working, silently, at their
-- next run — the exact class of failure the ops_events work exists to surface.
--
-- Dropping the one-argument version resolves the call to the defaulted
-- two-argument one, and the existing schedules keep working unchanged.

drop function if exists public.call_edge_function(text);
