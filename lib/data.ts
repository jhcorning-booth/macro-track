import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { localDate, retentionFloor } from "@/lib/dates";
import type {
  DailyLog,
  FoodEntry,
  NudgePref,
  Profile,
  SavedFood,
  Targets,
  TrialStatus,
  WeightEntry,
} from "@/lib/types";

export interface Bootstrap {
  profile: Profile;
  /** Today's calendar date in the profile's timezone. */
  today: string;
  /** Oldest date still inside the 90-day retention window. */
  floor: string;
  targets: Targets;
  entries: FoodEntry[];
  dailyLogs: DailyLog[];
  weights: WeightEntry[];
  savedFoods: SavedFood[];
  nudges: NudgePref[];
  trial: TrialStatus;
}

const DEFAULT_TARGETS: Targets = {
  calories_target: 2850,
  protein_target_g: 200,
  carbs_target_g: 300,
  fat_target_g: 80,
};

export async function loadBootstrap(): Promise<Bootstrap | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  const profile: Profile = profileRow ?? {
    id: user.id,
    timezone: "America/Chicago",
    weight_unit: "lb",
    goal_label: "lean bulk",
    onboarded_at: null,
    created_at: new Date().toISOString(),
  };

  const today = localDate(profile.timezone);
  const floor = retentionFloor(today);

  const [targetsRes, entriesRes, logsRes, weightsRes, savedRes, nudgesRes, trialRes] =
    await Promise.all([
      supabase
        .from("nutrition_targets")
        .select("calories_target, protein_target_g, carbs_target_g, fat_target_g")
        .lte("effective_from", today)
        .or(`effective_to.is.null,effective_to.gte.${today}`)
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("food_entries")
        .select("*")
        .eq("local_date", today)
        .order("consumed_at", { ascending: true }),
      supabase
        .from("daily_logs")
        .select("*")
        .gte("local_date", floor)
        .order("local_date", { ascending: true }),
      supabase
        .from("weight_entries")
        .select("*")
        .gte("local_date", floor)
        .order("local_date", { ascending: true }),
      supabase
        .from("saved_foods")
        .select("*")
        .order("last_used", { ascending: false })
        .limit(8),
      supabase.from("notification_prefs").select("kind, enabled, send_at"),
      supabase.rpc("trial_status"),
    ]);

  const entries = await attachPhotos(supabase, (entriesRes.data ?? []) as FoodEntry[]);

  return {
    profile,
    today,
    floor,
    targets: (targetsRes.data as Targets | null) ?? DEFAULT_TARGETS,
    entries,
    dailyLogs: (logsRes.data ?? []) as DailyLog[],
    weights: (weightsRes.data ?? []) as WeightEntry[],
    savedFoods: (savedRes.data ?? []) as SavedFood[],
    nudges: (nudgesRes.data ?? []) as NudgePref[],
    // A failed lookup must not hand out free analyses; assume blocked and let
    // the wall explain, rather than silently uncapping the key.
    trial: (trialRes.data as TrialStatus | null) ?? {
      plan: "trial",
      unlimited: false,
      blocked: true,
      reason: "expired",
      analyses_used: 0,
      contact_email: "jhcorning12@gmail.com",
    },
  };
}

type AnySupabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/** Photos live in a private bucket, so the list needs signed URLs. One batch
 *  call for the whole list rather than one per row. */
export async function attachPhotos(
  supabase: AnySupabase,
  entries: FoodEntry[],
): Promise<FoodEntry[]> {
  if (!entries.length) return entries;

  const { data: evidence } = await supabase
    .from("food_evidence")
    .select("food_entry_id, image_path")
    .in(
      "food_entry_id",
      entries.map((e) => e.id),
    )
    .not("image_path", "is", null);

  if (!evidence?.length) return entries;

  const firstByEntry = new Map<string, string>();
  for (const row of evidence as { food_entry_id: string; image_path: string }[]) {
    if (!firstByEntry.has(row.food_entry_id)) {
      firstByEntry.set(row.food_entry_id, row.image_path);
    }
  }

  const paths = [...firstByEntry.values()];
  const { data: signed } = await supabase.storage
    .from("food-photos")
    .createSignedUrls(paths, 60 * 60 * 6);

  const urlByPath = new Map(
    (signed ?? [])
      .filter((s) => s.signedUrl && s.path)
      .map((s) => [s.path as string, s.signedUrl]),
  );

  return entries.map((e) => {
    const path = firstByEntry.get(e.id);
    return { ...e, photo_url: path ? (urlByPath.get(path) ?? null) : null };
  });
}
