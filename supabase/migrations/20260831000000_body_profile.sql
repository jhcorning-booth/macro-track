-- Inputs for the calorie recommendation, plus the unit preferences that now
-- drive display across the whole app.
--
-- These are stored, not derived, because the user must be able to come back
-- and adjust one field without re-entering the rest. They are deliberately
-- NOT wired to anything automatic: a recommendation is applied only when the
-- user taps to apply it, and it writes a normal versioned target so past days
-- keep the number they were actually scored against.

do $$ begin
  alter table public.profiles add column height_unit text not null default 'ft_in'
    check (height_unit in ('cm', 'ft_in'));
exception when duplicate_column then null; end $$;

do $$ begin
  -- Canonical storage is metric for both; display converts. Storing what the
  -- user typed in whichever unit was active would make every read ambiguous.
  alter table public.profiles add column height_cm numeric(5,1)
    check (height_cm is null or (height_cm > 50 and height_cm < 260));
exception when duplicate_column then null; end $$;

do $$ begin
  alter table public.profiles add column birth_year integer
    check (birth_year is null or (birth_year > 1900 and birth_year < 2100));
exception when duplicate_column then null; end $$;

do $$ begin
  -- Mifflin-St Jeor takes a sex coefficient. 'unspecified' is honoured by
  -- averaging the two rather than refusing to answer.
  alter table public.profiles add column sex text
    check (sex is null or sex in ('female', 'male', 'unspecified'));
exception when duplicate_column then null; end $$;

do $$ begin
  alter table public.profiles add column activity_level text
    check (activity_level is null or
           activity_level in ('sedentary', 'light', 'active', 'very_active'));
exception when duplicate_column then null; end $$;

do $$ begin
  alter table public.profiles add column goal_weight_kg numeric(5,2)
    check (goal_weight_kg is null or (goal_weight_kg > 20 and goal_weight_kg < 400));
exception when duplicate_column then null; end $$;

do $$ begin
  -- The weight the recommendation was computed against, so Settings can notice
  -- drift and offer a recalculation instead of silently changing the target.
  alter table public.profiles add column plan_basis_weight_kg numeric(5,2);
exception when duplicate_column then null; end $$;

do $$ begin
  alter table public.profiles add column plan_computed_at timestamptz;
exception when duplicate_column then null; end $$;

comment on column public.profiles.birth_year is
  'Year only. Age is derived at read time so it does not silently go stale, '
  'and a birth date is more than this feature needs to know.';

comment on column public.profiles.height_cm is
  'Canonical centimetres regardless of the display preference in height_unit.';

-- The account may edit its own body inputs and unit preferences; plan/trial
-- columns stay off-limits (see 20260830070000_lock_plan_columns.sql).
grant update (
  timezone, weight_unit, goal_label, onboarded_at,
  height_unit, height_cm, birth_year, sex, activity_level,
  goal_weight_kg, plan_basis_weight_kg, plan_computed_at
) on public.profiles to authenticated;
