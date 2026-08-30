-- This is a single-user app, but a deployed URL is a public URL: without a
-- gate, anyone who finds it can create an account and spend the owner's
-- Anthropic key and storage quota through /api/analyze. A client-side check
-- would be bypassable — signInWithOtp talks to Supabase directly — so the rule
-- is enforced in the database.

create table if not exists public.allowed_emails (
  email      text primary key,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.allowed_emails enable row level security;
-- No policies: only the service role and SECURITY DEFINER code can read it.

comment on table public.allowed_emails is
  'Emails permitted to create an account. Empty table = the next signup claims '
  'ownership and is added automatically. Add more with: '
  'insert into public.allowed_emails (email) values (lower(''someone@example.com''));';

create or replace function public.enforce_signup_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(new.email, ''));
begin
  if v_email = '' then
    return new;                                   -- anonymous / phone signups
  end if;

  -- First account through the door claims the app and is remembered.
  if not exists (select 1 from public.allowed_emails) then
    insert into public.allowed_emails (email, note)
    values (v_email, 'claimed on first signup')
    on conflict do nothing;
    return new;
  end if;

  if exists (select 1 from public.allowed_emails a where a.email = v_email) then
    return new;
  end if;

  raise exception 'This tracker is private.'
    using errcode = '42501';
end;
$$;

revoke all on function public.enforce_signup_allowlist() from public, anon, authenticated;

drop trigger if exists on_auth_user_signup on auth.users;
create trigger on_auth_user_signup
  before insert on auth.users
  for each row execute function public.enforce_signup_allowlist();
