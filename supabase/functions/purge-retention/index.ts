// 90-day retention (design §Notes 7). Deletes rows AND the stored photos —
// the Settings copy promises "photos included", so the storage objects have to
// go through the Storage API, not just a row delete.

import { createClient } from "jsr:@supabase/supabase-js@2";

const RETENTION_DAYS = 90;
const BUCKET = "food-photos";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {

  // 4. Operational events older than 30 days. ops_events is bucketed by
  //    (day, source, code) so it grows by distinct codes rather than by
  //    traffic, but it is still the one table here nothing else ever prunes.
  //    The rate-guard rows are pure scaffolding and go after a day.
  const opsFloor = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  await supabase.from("ops_events").delete().lt("event_day", opsFloor);
  await supabase
    .from("ops_event_rate")
    .delete()
    .lt("hour_bucket", new Date(Date.now() - 86_400_000).toISOString());

    return new Response("Forbidden", { status: 403 });
  }

  // The floor is generous by a day so no user loses a day early to timezone
  // skew — every profile's local date is at most one day off UTC.
  const floor = new Date(Date.now() - (RETENTION_DAYS + 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // 1. Photos attached to entries that are about to roll off.
  const { data: stale } = await supabase
    .from("food_evidence")
    .select("id, image_path, food_entries!inner(local_date)")
    .lt("food_entries.local_date", floor)
    .not("image_path", "is", null);

  const paths = (stale ?? [])
    .map((r) => r.image_path as string)
    .filter(Boolean);

  let removedFiles = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const { error } = await supabase.storage.from(BUCKET).remove(batch);
    if (!error) removedFiles += batch.length;
  }

  // 2. Orphaned evidence from failed runs that was never linked to an entry.
  const orphanFloor = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const { data: orphans } = await supabase
    .from("food_evidence")
    .select("id, image_path")
    .is("food_entry_id", null)
    .lt("created_at", orphanFloor);

  const orphanPaths = (orphans ?? []).map((r) => r.image_path as string).filter(Boolean);
  if (orphanPaths.length) {
    await supabase.storage.from(BUCKET).remove(orphanPaths);
    removedFiles += orphanPaths.length;
  }
  if (orphans?.length) {
    await supabase
      .from("food_evidence")
      .delete()
      .in("id", orphans.map((o) => o.id));
  }

  // 3. The rows. food_evidence cascades from food_entries.
  const { count: entriesDeleted } = await supabase
    .from("food_entries")
    .delete({ count: "exact" })
    .lt("local_date", floor);

  const { count: weightsDeleted } = await supabase
    .from("weight_entries")
    .delete({ count: "exact" })
    .lt("local_date", floor);

  await supabase.from("notification_log").delete().lt("local_date", floor);

  return Response.json({
    ok: true,
    floor,
    removedFiles,
    entriesDeleted: entriesDeleted ?? 0,
    weightsDeleted: weightsDeleted ?? 0,
  });
});
