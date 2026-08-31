-- The upgrade-contact address was hardcoded as this column's default, which put
-- a real personal email address into a public repository where address
-- harvesters scrape continuously. The address itself is fine as DATA — it has
-- to reach users on the trial wall — but it does not belong in source.
--
-- The default is now empty. Existing rows keep whatever they hold, so this
-- deployment is unaffected; a fresh clone starts blank and the UI simply omits
-- the contact line until someone sets it:
--
--   update public.app_settings set contact_email = 'you@example.com';

alter table public.app_settings alter column contact_email set default '';

comment on column public.app_settings.contact_email is
  'Where trial users are told to write for a paid account. Deliberately empty '
  'by default — set it per deployment rather than committing an address.';
