import type { SupabaseClient } from "@supabase/supabase-js";
import type { FoodEntry } from "./types";

/** Photos live in a private bucket, so a list of entries needs signed URLs.
 *
 *  `photo_url` is NOT a column — it is synthesised. Any code path that
 *  re-reads entries with `select("*")` and drops this step will silently blank
 *  every thumbnail in the list, which is exactly what happened when the
 *  midnight rollover reloaded the day.
 *
 *  Client-side twin of the server helper in lib/data.ts; kept separate because
 *  that module is `server-only`. */
export async function attachPhotoUrls(
  supabase: SupabaseClient,
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

  const { data: signed } = await supabase.storage
    .from("food-photos")
    .createSignedUrls([...firstByEntry.values()], 60 * 60 * 6);

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
