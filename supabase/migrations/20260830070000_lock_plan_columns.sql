-- Privilege escalation: the "own profile" RLS policy is FOR ALL, so a signed-in
-- user could `update profiles set plan = 'paid'` on their own row and hand
-- themselves unlimited use of the deployment's Anthropic key. RLS gates rows,
-- not columns, so the row policy could never have stopped this.
--
-- Fixed with column-level privileges, which apply before RLS is consulted:
-- users may still edit their own preferences, but the billing-relevant columns
-- are simply not updatable by them.

revoke update on public.profiles from authenticated;
grant update (timezone, weight_unit, goal_label, onboarded_at)
  on public.profiles to authenticated;

-- Same reasoning for the limits themselves: readable so the UI can show real
-- numbers, never writable from a session.
revoke insert, update, delete on public.app_settings from authenticated, anon;

-- And the usage ledger: readable, never mutable, so the counter cannot be
-- rewound by the account it meters.
revoke insert, update, delete on public.ai_usage from authenticated, anon;

comment on column public.profiles.plan is
  'trial | paid | owner. NOT updatable by the account itself — column privilege '
  'is revoked from `authenticated`. Change it with the service role.';
