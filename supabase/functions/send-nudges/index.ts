// Delivers the five nudges. Runs every 15 minutes from pg_cron; each nudge
// fires at most once per user per local day, and only when it is actually
// true — a "720 to go" push after the target is hit would be noise.
//
// Copy is the design's, verbatim: warm coach, never punitive.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Kind =
  | "no_logging"
  | "calories_remaining"
  | "target_reached"
  | "protein_checkin"
  | "evening_nudge";

const WINDOW_MIN = 15;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:noreply@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

function localParts(timeZone: string, now: Date) {
  const date = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(now);
  const t = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(now);
  const h = Number(t.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(t.find((p) => p.type === "minute")?.value ?? 0);
  return { date, minutes: h * 60 + m };
}

function minutesOf(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

interface Day {
  entry_count: number;
  total_calories: number;
  total_protein_g: number;
  calories_target: number | null;
  protein_target_g: number | null;
  calorie_goal_achieved: boolean;
}

/** daily_logs only materialises a row for a date that has a food or weight
 *  entry. On a day with nothing logged there is no row at all — and that is
 *  precisely the day the nudges exist for — so the targets are resolved from
 *  the versioned table instead and the day is treated as a real zero. */
async function emptyDayFor(userId: string, date: string): Promise<Day> {
  const { data } = await supabase
    .from("nutrition_targets")
    .select("calories_target, protein_target_g")
    .eq("user_id", userId)
    .lte("effective_from", date)
    .or(`effective_to.is.null,effective_to.gte.${date}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    entry_count: 0,
    total_calories: 0,
    total_protein_g: 0,
    calories_target: data?.calories_target ?? null,
    protein_target_g: data?.protein_target_g ?? null,
    calorie_goal_achieved: false,
  };
}

/** Returns the body copy, or null when the nudge isn't warranted right now. */
function copyFor(kind: Kind, day: Day): string | null {
  const cal = Number(day.total_calories ?? 0);
  const target = Number(day.calories_target ?? 0);
  const remaining = target - cal;
  const protein = Number(day.total_protein_g ?? 0);
  const proteinTarget = Number(day.protein_target_g ?? 0);
  const proteinShort = proteinTarget - protein;

  // Without a target there is nothing meaningful to say.
  if (!target && kind !== "no_logging") return null;

  switch (kind) {
    case "no_logging":
      return Number(day.entry_count ?? 0) === 0
        ? "Morning — nothing in the tank yet."
        : null;
    case "calories_remaining":
      return remaining > 0 ? `${fmt(remaining)} to go. One shake covers most of it.` : null;
    case "target_reached":
      return day.calorie_goal_achieved ? "Tank full. Anything else is bonus." : null;
    case "protein_checkin":
      return proteinShort >= 15 ? `${fmt(proteinShort)} g short on protein — easy fix.` : null;
    case "evening_nudge":
      return remaining > 0 ? `${fmt(remaining)} below target with a few hours left.` : null;
  }
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("Forbidden", { status: 403 });
  }

  const now = new Date();
  const { data: profiles } = await supabase.from("profiles").select("id, timezone");
  let sent = 0;

  for (const profile of profiles ?? []) {
    const { date, minutes } = localParts(profile.timezone, now);

    const [{ data: prefs }, { data: subs }, { data: dayRows }, { data: logged }] =
      await Promise.all([
        supabase
          .from("notification_prefs")
          .select("kind, enabled, send_at")
          .eq("user_id", profile.id)
          .eq("enabled", true),
        supabase
          .from("push_subscriptions")
          .select("id, endpoint, p256dh, auth")
          .eq("user_id", profile.id),
        supabase
          .from("daily_logs")
          .select("*")
          .eq("user_id", profile.id)
          .eq("local_date", date),
        supabase
          .from("notification_log")
          .select("kind")
          .eq("user_id", profile.id)
          .eq("local_date", date),
      ]);

    if (!subs?.length || !prefs?.length) continue;

    const alreadySent = new Set((logged ?? []).map((r) => r.kind as string));
    const day: Day = (dayRows?.[0] as Day | undefined) ??
      (await emptyDayFor(profile.id, date));

    for (const pref of prefs) {
      const kind = pref.kind as Kind;
      if (alreadySent.has(kind)) continue;

      // target_reached is event-shaped, not scheduled — it fires as soon as
      // the crossing is visible. The other four wait for their time.
      if (kind !== "target_reached") {
        const due = minutesOf(pref.send_at as string);
        if (minutes < due || minutes >= due + WINDOW_MIN) continue;
      }

      const body = copyFor(kind, day);
      if (!body) continue;

      const payload = JSON.stringify({ title: "MacroTrack", body, tag: kind, url: "/" });

      let delivered = false;
      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
          );
          delivered = true;
        } catch (err) {
          // 404/410 means the endpoint is dead — drop it rather than retrying forever.
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          }
        }
      }

      if (delivered) {
        await supabase
          .from("notification_log")
          .insert({ user_id: profile.id, kind, local_date: date });
        sent++;
      }
    }
  }

  return Response.json({ ok: true, sent });
});
