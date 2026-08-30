# MacroTrack AI

Photo-first calorie and macro tracker. Open → shutter → it's logged. A
multimodal model reads the photo (plus an optional typed note or voice), the
app does every calculation, and the day's totals update in place.

A day is a **win the moment calories reach the target**. Going over is still a
win. Macros are shown as information, never as a verdict.

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

Email + one-time code. Enter your address, Supabase emails a code, type it in.
The session persists and refreshes indefinitely, so this is a once-per-device
step.

> **Before you rely on it:** Supabase's built-in email service only delivers to
> your own project-team addresses and is rate-limited to a couple of messages
> an hour. That's fine for a single user signing in once per device. If you
> ever get locked out, configure custom SMTP in
> *Project Settings → Authentication → SMTP*.

**Signup is gated.** A deployed URL is a public URL, and an open signup would
let a stranger create an account and spend your Anthropic key. A database
trigger enforces an allowlist: while `public.allowed_emails` is empty, the
**first** account to sign up claims the app and is added automatically;
everyone after that is rejected. So sign in once yourself before sharing the
URL anywhere. To add or change an address:

```sql
insert into public.allowed_emails (email) values (lower('you@example.com'));
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
| `npm test` | 33 tests over the arithmetic in `lib/calc.ts` and `lib/dates.ts` |
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
lib/
  calc.ts          every derived number lives here (tested)
  dates.ts         local-date + timezone handling (tested)
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
