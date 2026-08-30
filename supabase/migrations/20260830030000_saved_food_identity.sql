-- Saved-food memory was racy: two items from the same batch could both miss
-- the "does this exist" lookup and each insert a row, after which neither ever
-- incremented. Give the library a real identity and make remember-or-increment
-- a single atomic statement.

alter table public.saved_foods
  add column if not exists normalized_name text
  generated always as (lower(btrim(name))) stored;

-- Collapse any duplicates that already exist, keeping the most-used row.
with ranked as (
  select id, user_id, lower(btrim(name)) as norm, times_logged,
         row_number() over (
           partition by user_id, lower(btrim(name))
           order by times_logged desc, created_at asc
         ) as rn,
         sum(times_logged) over (partition by user_id, lower(btrim(name))) as total
    from public.saved_foods
)
update public.saved_foods s
   set times_logged = r.total
  from ranked r
 where s.id = r.id and r.rn = 1;

delete from public.saved_foods s
 using (
   select id, row_number() over (
     partition by user_id, lower(btrim(name))
     order by times_logged desc, created_at asc
   ) as rn
   from public.saved_foods
 ) r
 where s.id = r.id and r.rn > 1;

create unique index if not exists saved_foods_user_name_idx
  on public.saved_foods (user_id, normalized_name);

-- A barcode is a useful hint, not an identity: two products can legitimately
-- share one in the wild, and a clash must not break the upsert below.
drop index if exists public.saved_foods_barcode_idx;
create index if not exists saved_foods_barcode_idx
  on public.saved_foods (user_id, barcode) where barcode is not null;

/** Remember a confirmed food, or bump the one already there. Atomic, so a
 *  batch of photos of the same food cannot fork the library. */
create or replace function public.remember_food(
  p_name     text,
  p_calories numeric,
  p_protein  numeric,
  p_carbs    numeric,
  p_fat      numeric,
  p_serving  text default null,
  p_barcode  text default null
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    return null;
  end if;

  insert into public.saved_foods
    (user_id, name, calories, protein_g, carbs_g, fat_g, serving_size, barcode)
  values
    (v_user, btrim(p_name), p_calories, p_protein, p_carbs, p_fat, p_serving, p_barcode)
  on conflict (user_id, normalized_name) do update
     set times_logged  = public.saved_foods.times_logged + 1,
         last_used     = now(),
         -- Keep the newest confirmed values; the user just re-confirmed them.
         calories      = excluded.calories,
         protein_g     = excluded.protein_g,
         carbs_g       = excluded.carbs_g,
         fat_g         = excluded.fat_g,
         serving_size  = coalesce(excluded.serving_size, public.saved_foods.serving_size),
         barcode       = coalesce(excluded.barcode, public.saved_foods.barcode)
  returning id into v_id;

  return v_id;
end;
$$;
