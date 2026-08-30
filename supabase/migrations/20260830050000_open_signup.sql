-- Open signup to anyone. Requested deliberately: this is no longer a
-- single-user tracker.
--
-- What this does NOT change: data isolation. Every table and the derived
-- daily_logs view are behind RLS keyed on auth.uid(), storage objects are
-- scoped by a user-id path prefix, and a client cannot insert a row attributed
-- to someone else. A new account sees an empty app and nothing of anyone
-- else's.
--
-- What it DOES change: anyone with the URL can create an account, and every
-- account can run photo analysis against the deployment's Anthropic key. There
-- is no per-user quota. That is a cost exposure, not a data one.
--
-- The gate is kept, just disarmed, so it can be restored in one statement:
--
--   create trigger on_auth_user_signup
--     before insert on auth.users
--     for each row execute function public.enforce_signup_allowlist();
--
-- With the trigger back and public.allowed_emails empty, the next signup
-- claims the app again; with rows in it, only those addresses may sign up.

drop trigger if exists on_auth_user_signup on auth.users;

comment on function public.enforce_signup_allowlist() is
  'Signup gate. Currently DISARMED — the trigger on auth.users was dropped in '
  'migration 20260830050000_open_signup.sql. Re-create that trigger to close '
  'signup again.';
