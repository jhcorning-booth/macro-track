# MacroTrack AI

Photo-first calorie and macro tracker. Open → shutter → it's logged. A
multimodal model reads the photo (plus an optional typed note or voice), the
app does every calculation, and the day's totals update in place.

A day is a **win the moment calories reach the target**. Going over is still a
win. Macros are shown as information, never as a verdict.

Don't know what to aim for? Settings works it out from height, weight, age and
a goal weight — an estimate with hard safety floors, never applied until you
tap, and never required.

Built from `../design_handoff_macrotrack_ai/` — the PRD and the high-fidelity
design handoff. Today uses **variant A, the fill gauge**.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind v4 |
| Backend | Supabase — Postgres, Auth, Storage, Edge Functions, pg_cron |
| AI | Anthropic `claude-opus-5`, structured output via a Zod schema |
| Nutrition data | Personal saved foods → Open Food Facts (barcode) → USDA FDC (optional) → visual estimate |
| Install | PWA — manifest, service worker, Web Push |

Supabase project: **`tzykugpyzsfqrgllkdih`** (us-east-2), created for this app.

---

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:3000 and narrow the window to a phone width.

### What you must add yourself

`.env.local` is already written with the Supabase URL, keys, generated VAPID
keys, and a cron secret. **One value is blank and the app needs it:**

```
ANTHROPIC_API_KEY=
```

Paste your key there and restart. Everything except photo analysis works
without it; with the key blank, a capture still stores its photo and note and
the toast offers **Try again** — nothing is lost.

Optional: `USDA_API_KEY` (free from [FoodData Central](https://fdc.nal.usda.gov/api-key-signup.html))
adds a database lookup for unlabelled foods. Open Food Facts needs no key.

### Signing in

Email + a one-time code. Enter your address, you get a six-digit code, type it
in. The session persists and refreshes indefinitely, so this is a
once-per-device step.

Auth email goes through **Gmail SMTP** (`MAIL_FROM` + `GMAIL_APP_PASSWORD`,
read by `supabase config push`). That is not a preference — on the free tier
with Supabase's built-in mailer, template overrides are rejected outright, so
the email can only ever contain a magic *link* and never the code this screen
asks for. Custom SMTP is what makes the code appear at all.

### Who can sign up

**Signup is open: anyone with the URL can create an account.** The allowlist
trigger that used to gate it was deliberately dropped in
`20260830050000_open_signup.sql`.

What that does *not* affect is data isolation. RLS is keyed on `auth.uid()`
across every table and the derived view, storage is scoped by a user-id path
prefix, and a client cannot insert a row attributed to someone else — verified
by signing in as a second user and finding nothing. What it does expose is
cost, which is what the trial below is for.

To close signup again, re-create the trigger (the table and function are still
there):

```sql
create trigger on_auth_user_signup
  before insert on auth.users
  for each row execute function public.enforce_signup_allowlist();
```

With `public.allowed_emails` empty, the next signup claims the app; with rows
in it, only those addresses may sign up.

### Trial limits

Because signup is open, every account is metered: **14 days or 150 photo
analyses**, whichever runs out first — roughly $3.75 of exposure per account.
Quick-adds and history re-adds are free, since they make no model call.

Enforcement is in the database, not the app. `consume_ai_credit()` takes a
per-user advisory lock, checks and records in one `SECURITY DEFINER` call, and
a refused call records nothing. `ai_usage` and `app_settings` carry no write
privilege at all, and `profiles.plan` is not updatable by the account it
describes — RLS gates rows, not columns, so that one needs a column privilege.

Tune without a migration:

```sql
update public.app_settings set trial_days = 30, trial_analyses = 300;
```

Upgrade someone who gets in touch:

```sql
update public.profiles set plan = 'paid'
 where id = (select id from auth.users where email = 'them@example.com');
```

### Seeing it with data

```bash
npm run seed you@example.com          # ~40 days of plausible history
npm run seed you@example.com -- --wipe  # delete that account entirely
```

Development only — it uses the service key and bypasses RLS.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm test` | 58 tests over `lib/calc.ts`, `lib/dates.ts`, `lib/recommend.ts` and `lib/units.ts` |
| `npm run lint` | ESLint |
| `npm run seed <email>` | Seed / wipe a demo account |
| `npm run setup:cron` | Re-store `CRON_SECRET` in Supabase Vault after rotating it |

---

## How it fits together

```
components/
  App.tsx          shell: screen switching, overlays, tab bar
  store.tsx        ALL state and mutations — screens just call useApp()
  overlays.tsx     processing · toast · edit sheet · celebration
  ui.tsx           Thumb · ConfidencePill · StatCard · StepperRow · Toggle
  icons.tsx        the icon set
  screens/         Today · Add · History · Trends · Settings · Weight+Onboarding
  SetupCalculator.tsx  the body-inputs → calorie recommendation form
lib/
  calc.ts          every derived number lives here (tested)
  dates.ts         local-date + timezone handling (tested)
  recommend.ts     Mifflin-St Jeor → activity → paced gap, with the floors (tested)
  units.ts         kg/lb and cm/ft-in; storage is metric, display converts (tested)
  photos.ts        re-attaches signed photo URLs after a client-side reload
  analyze.ts       the model call and its schema
  data.ts          server-side bootstrap fetch
  nutrition-sources.ts   Open Food Facts / USDA lookups
app/api/analyze    the pipeline, streamed as SSE
supabase/          migrations + the two scheduled Edge Functions
```

### The one rule that shapes everything

**The model interprets; the app calculates.** When a nutrition label is
legible the model returns the label's own per-serving figures and how many
servings were eaten — it never multiplies. `applyServing()` does that, and
totals, averages, adherence, and rolling correlations are all computed in
`lib/calc.ts`. A model slip can't produce an internally inconsistent entry.

The PRD's worked example is a test: a 4-scoop / 1,290 kcal label plus "I had
two scoops" must come out at exactly 645 kcal · 25 P · 128 C · 4.5 F.

### Evidence hierarchy (PRD §11)

1. A readable nutrition label in the photo — the source of truth.
2. What you said or typed ("only half", "two scoops", "about 70%").
3. A saved food from your own library — copied exactly, no inference.
4. Open Food Facts by barcode, or USDA by name for low-confidence items.
5. Visual estimation, last, labelled `estimated`.

A database hit never overrides a label the model actually read.

### Versioned targets

`nutrition_targets` rows carry `effective_from` / `effective_to`, and a Postgres
exclusion constraint prevents overlaps. The `daily_logs` view joins each day to
the target that was in force **on that date**, so changing your target today
never rewrites what August looked like.

### Retention

90 days, enforced by `purge-retention` (daily at 09:00 UTC): rows *and* the
stored photos, plus orphaned evidence from failed runs. Surfaced in three
places in the UI, as the design requires.

### Nudges

`send-nudges` runs every 15 minutes and delivers Web Push. Each nudge fires at
most once per user per local day, at its configured time, and only when it's
actually true — no "720 to go" after you've already hit the target.
`target_reached` is event-shaped rather than scheduled. A day with nothing
logged has no `daily_logs` row at all, so the job resolves that day's target
from the versioned table directly — otherwise the nudges would go quiet on
exactly the days they exist for.

Both jobs are scheduled with pg_cron and authenticate to the Edge Functions
with a secret held in Supabase Vault — never in a migration file.

On iPhone, Web Push only works once the app is **added to the Home Screen**.

---

## Deploying

The web app needs only four variables, and exactly one of them is a secret:

| Variable | Why |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public; RLS is what protects the data |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | public by design |
| `ANTHROPIC_API_KEY` | **secret** — server-side only |

Auth email (`MAIL_FROM`, `GMAIL_APP_PASSWORD`) is read by `supabase config
push`, not by the web app — it configures Supabase's SMTP, so it never needs to
reach the host either.

Deliberately *not* on the web host: the Supabase **service-role key**, the
**VAPID private key**, and `CRON_SECRET`. Nothing in the app needs to bypass
RLS — every server route runs as the signed-in user — and push sending and the
retention job live in Supabase Edge Functions, which hold those secrets
themselves. So a compromise of the web host cannot read another account's data
or forge a push.

The scheduled jobs run inside Supabase, so they work regardless of where the
frontend is hosted.

---

## Deliberate omissions

Out of MVP scope per PRD §5: exercise, expenditure, wearables, meal planning,
social, micronutrients. Barcode *scanning* (as opposed to the model reading a
barcode it can see) and duplicate-similarity warnings are PRD §40 / V1.1.

Photo storage is a private bucket with per-user path policies; entries never
merge across photos (PRD §9) — two shots of the same food stay two entries,
which is the user's call to fix.
