/**
 * Seeds an account with ~40 days of plausible history so every screen can be
 * looked at before you've logged anything real.
 *
 *   node scripts/seed-demo.mjs you@example.com          # seed (creates if new)
 *   node scripts/seed-demo.mjs you@example.com --otp    # also print a sign-in code
 *   node scripts/seed-demo.mjs you@example.com --wipe   # delete the account entirely
 *
 * Uses the service key, so it bypasses RLS. Development only.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const email = process.argv[2];
if (!email) {
  console.error("usage: node scripts/seed-demo.mjs <email> [--otp] [--wipe]");
  process.exit(1);
}
const wipe = process.argv.includes("--wipe");
const wantOtp = process.argv.includes("--otp");

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } },
);

/* ------------------------------------------------------------- helpers */

const iso = (d) => d.toISOString().slice(0, 10);
const dayOffset = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
// Deterministic pseudo-random so reseeding produces the same history.
let seed = 1337;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const jitter = (base, spread) => base + (rnd() - 0.5) * 2 * spread;

async function findUser() {
  let page = 1;
  for (;;) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const hit = data?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (!data?.users?.length || data.users.length < 200) return null;
    page++;
  }
}

/* ------------------------------------------------------------- the food */

const FOODS = [
  { name: "Protein shake", cal: 230, p: 42, c: 9, f: 3.5, conf: "high", src: "saved_food", label: "Saved food · matched from your library", why: "Matched a food you've confirmed before. Values came straight from your library — no guessing." },
  { name: "Greek yogurt, 2%", cal: 140, p: 20, c: 9, f: 3, conf: "high", src: "nutrition_label", label: "Nutrition label · read from photo", why: "Read the label directly: 1 container, 140 kcal. The label is the source of truth." },
  { name: "Cajun salmon & shrimp", cal: 720, p: 45, c: 18, f: 53, conf: "low", src: "visual_estimate", label: "Visual estimate · mixed dish", why: "No label, mixed plate. Estimated from portion size against similar meals — the butter sauce is the least certain part." },
  { name: "Mocha protein coffee", cal: 100, p: 20, c: 5, f: 0.5, conf: "medium", src: "food_database", label: "Packaged food · no readable label", why: "Recognized the bottle but couldn't read the label. Used the product's published nutrition." },
  { name: "Peanut butter toast", cal: 380, p: 14, c: 38, f: 19, conf: "high", src: "saved_food", label: "Saved food · matched from your library", why: "Two slices with your usual two tablespoons of peanut butter." },
  { name: "Whole milk, 16 oz", cal: 300, p: 16, c: 24, f: 16, conf: "high", src: "nutrition_label", label: "Nutrition label · read from photo", why: "Carton label, two cups poured. Straight multiplication, no estimating." },
  { name: "Chicken burrito bowl", cal: 890, p: 55, c: 92, f: 30, conf: "medium", src: "food_database", label: "Restaurant item · published nutrition", why: "Matched the chain's published builder for rice, beans, chicken, and cheese." },
  { name: "Vegan Naked Mass", cal: 645, p: 25, c: 128, f: 4.5, conf: "high", src: "nutrition_label", label: "Nutrition label + your note", why: "Label says 4 scoops = 1,290 kcal. You said “two scoops”, so I halved it. 2 scoops = 0.5 serving." },
  { name: "Grilled salmon bowl", cal: 670, p: 48, c: 61, f: 25, conf: "low", src: "visual_estimate", label: "Visual estimate · plated meal", why: "Salmon, white rice, and broccoli. Portion judged against the plate rim." },
  { name: "Garlic dill steelhead trout", cal: 540, p: 46, c: 4, f: 37, conf: "low", src: "visual_estimate", label: "Visual estimate · mixed dish", why: "Estimated from fillet size; the butter in the pan is the least certain part." },
  { name: "Overnight oats", cal: 420, p: 18, c: 62, f: 12, conf: "high", src: "saved_food", label: "Saved food · matched from your library", why: "Your standing recipe — oats, milk, chia, and a scoop of whey." },
];

// Local wall-clock hours (America/Chicago, UTC-5 in August). A 9 pm local
// meal lands on the next UTC day — local_date is what the app groups by, so
// that's correct, not a bug.
const LOCAL_HOURS = [7, 9, 12, 15, 18, 20, 21];
const UTC_OFFSET_HOURS = 5;

async function seedUser(userId) {
  console.log("clearing previous seed…");
  await admin.from("food_entries").delete().eq("user_id", userId);
  await admin.from("weight_entries").delete().eq("user_id", userId);
  await admin.from("saved_foods").delete().eq("user_id", userId);
  await admin.from("nutrition_targets").delete().eq("user_id", userId);

  await admin.from("profiles").upsert({
    id: userId,
    timezone: "America/Chicago",
    weight_unit: "lb",
    goal_label: "lean bulk",
    onboarded_at: new Date().toISOString(),
  });

  // Two target versions, so History proves each day keeps its own target.
  await admin.from("nutrition_targets").insert([
    { user_id: userId, calories_target: 2500, protein_target_g: 180, carbs_target_g: 280, fat_target_g: 75, effective_from: dayOffset(-45), effective_to: dayOffset(-11) },
    { user_id: userId, calories_target: 2850, protein_target_g: 200, carbs_target_g: 300, fat_target_g: 80, effective_from: dayOffset(-10), effective_to: null },
  ]);

  // Saved-food library → the "One tap again" row.
  const library = FOODS.slice(0, 5).map((f, i) => ({
    user_id: userId,
    name: f.name,
    calories: f.cal,
    protein_g: f.p,
    carbs_g: f.c,
    fat_g: f.f,
    times_logged: 14 - i * 2,
    last_used: new Date(Date.now() - i * 3600_000).toISOString(),
  }));
  await admin.from("saved_foods").insert(library);

  // 40 days of entries. Today is left partial so the gauge sits mid-fill.
  const entries = [];
  for (let back = 40; back >= 0; back--) {
    const date = dayOffset(-back);
    const target = back > 10 ? 2500 : 2850;
    if (back > 0 && rnd() < 0.08) continue; // a few missed days

    const wantsBigDay = rnd() < 0.6;
    const goal = wantsBigDay ? target * jitter(1.06, 0.05) : target * jitter(0.88, 0.06);
    const cap = back === 0 ? target * 0.42 : goal; // today: partly filled

    let total = 0;
    let i = 0;
    while (total < cap - 120 && i < LOCAL_HOURS.length) {
      const f = pick(FOODS);
      const at = new Date(
        Date.parse(`${date}T00:00:00Z`) +
          (LOCAL_HOURS[i] + UTC_OFFSET_HOURS) * 3_600_000 +
          Math.floor(rnd() * 59) * 60_000,
      );
      entries.push({
        user_id: userId,
        local_date: date,
        consumed_at: at.toISOString(),
        name: f.name,
        calories: f.cal,
        protein_g: f.p,
        carbs_g: f.c,
        fat_g: f.f,
        quantity: 1,
        unit: null,
        source_type: f.src,
        confidence: f.conf,
        source_label: f.label,
        reasoning: f.why,
      });
      total += f.cal;
      i++;
    }
  }

  for (let i = 0; i < entries.length; i += 400) {
    const { error } = await admin.from("food_entries").insert(entries.slice(i, i + 400));
    if (error) throw error;
  }
  console.log(`inserted ${entries.length} food entries`);

  // Weight: a slow lean-bulk climb with real daily noise.
  const weights = [];
  let w = 138.6;
  for (let back = 40; back >= 0; back--) {
    w += 0.055 + (rnd() - 0.5) * 0.9;
    if (rnd() < 0.12 && back > 0) continue; // some mornings get skipped
    weights.push({
      user_id: userId,
      local_date: dayOffset(-back),
      weight: Math.round(w * 10) / 10,
      unit: "lb",
    });
  }
  const { error: werr } = await admin.from("weight_entries").insert(weights);
  if (werr) throw werr;
  console.log(`inserted ${weights.length} weight entries`);
}

/* ----------------------------------------------------------------- run */

const existing = await findUser();

if (wipe) {
  if (!existing) {
    console.log("no such user; nothing to wipe");
  } else {
    await admin.auth.admin.deleteUser(existing.id);
    console.log("deleted", email);
  }
  process.exit(0);
}

let user = existing;
if (!user) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error) throw error;
  user = data.user;
  console.log("created", email, user.id);
} else {
  console.log("found", email, user.id);
}

await seedUser(user.id);

if (wantOtp) {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  console.log("\nsign-in code:", data.properties.email_otp);
}

console.log("\ndone.");
