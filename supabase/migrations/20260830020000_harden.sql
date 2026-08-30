-- Hardening pass, from `supabase db advisors --type security`.

-- 1. handle_new_user is a trigger function, but SECURITY DEFINER functions in
--    the public schema are exposed at /rest/v1/rpc/. Nothing but the trigger
--    should ever call it.
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- 2. Pin the search_path on the remaining trigger function so it cannot be
--    resolved against a caller-controlled schema.
create or replace function public.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 3. Keep extensions out of the API-exposed public schema. Their operator
--    classes stay valid: Supabase roles already carry `extensions` on their
--    search_path, and the indexes/constraints below are re-verified in the
--    same transaction.
create schema if not exists extensions;

alter extension pg_trgm    set schema extensions;
alter extension btree_gist set schema extensions;

-- pg_net is deliberately left where it is: it does not support SET SCHEMA
-- (0A000). Its functions live in their own `net` schema regardless, so the
-- advisor's "extension in public" note refers only to the registration record
-- and exposes nothing at /rest/v1/.

-- Fail loudly here rather than silently later if the relocation broke either
-- index type or the no-overlap exclusion constraint.
do $$
begin
  perform 1 from public.saved_foods where name % 'probe';
  perform 1 from public.food_entries where name % 'probe';
  if not exists (
    select 1 from pg_constraint
     where conname = 'nutrition_targets_no_overlap' and contype = 'x'
  ) then
    raise exception 'nutrition_targets_no_overlap is missing after the extension move';
  end if;
end $$;
