import { NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { attachPhotos } from "@/lib/data";
import { analyzeFood } from "@/lib/analyze";
import { lookupBarcode, lookupUsda, type SourceHit } from "@/lib/nutrition-sources";
import { round1 } from "@/lib/calc";
import { isIsoDate } from "@/lib/dates";
import type { AnalyzeEvent, AnalyzedItem, FoodEntry, SavedFood } from "@/lib/types";

export const runtime = "nodejs";
// Measured worst case is ~10s. 60 is the ceiling on Vercel's Hobby plan and
// well clear of anything this route does.
export const maxDuration = 60;

const BUCKET = "food-photos";

/** Streams real pipeline stages so the processing overlay tracks work in
 *  flight rather than a timer. Evidence is written before the model is called,
 *  so a failure never costs the user their photo (PRD §37). */
export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const form = await req.formData();
  const localDate = String(form.get("local_date") ?? "");
  if (!isIsoDate(localDate)) {
    return new Response("Bad local_date", { status: 400 });
  }

  const note = String(form.get("note") ?? "").slice(0, 2000);
  const transcript = String(form.get("transcript") ?? "").slice(0, 4000);
  const retryIds = String(form.get("retry_evidence") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const uploads = form.getAll("images").filter((f): f is File => f instanceof File);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (evt: AnalyzeEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));

      let evidenceIds: string[] = [];

      try {
        send({ type: "stage", stage: "reading_label" });

        /* ---------------------------------------- 1. preserve evidence */

        let images: { base64: string; mime: string; path: string | null }[] = [];
        let noteText = note;
        let transcriptText = transcript;

        if (retryIds.length) {
          // Re-run on evidence already stored — the user must not re-photograph.
          const { data: rows } = await supabase
            .from("food_evidence")
            .select("id, image_path, text_input, voice_transcript")
            .in("id", retryIds)
            .is("food_entry_id", null);

          evidenceIds = (rows ?? []).map((r) => r.id as string);
          noteText = (rows ?? []).find((r) => r.text_input)?.text_input ?? note;
          transcriptText =
            (rows ?? []).find((r) => r.voice_transcript)?.voice_transcript ?? transcript;

          for (const row of rows ?? []) {
            const path = row.image_path as string | null;
            if (!path) continue;
            const { data: blob } = await supabase.storage.from(BUCKET).download(path);
            if (!blob) continue;
            images.push({
              base64: Buffer.from(await blob.arrayBuffer()).toString("base64"),
              mime: blob.type || "image/jpeg",
              path,
            });
          }
        } else {
          images = await Promise.all(
            uploads.map(async (file) => {
              const bytes = Buffer.from(await file.arrayBuffer());
              const ext = (file.type.split("/")[1] ?? "jpg").replace("jpeg", "jpg");
              const path = `${user.id}/${localDate}/${crypto.randomUUID()}.${ext}`;
              const { error } = await supabase.storage
                .from(BUCKET)
                .upload(path, bytes, { contentType: file.type || "image/jpeg" });
              return {
                base64: bytes.toString("base64"),
                mime: file.type || "image/jpeg",
                path: error ? null : path,
              };
            }),
          );

          const evidenceRows = images.length
            ? images.map((img, i) => ({
                user_id: user.id,
                image_path: img.path,
                text_input: i === 0 ? noteText || null : null,
                voice_transcript: i === 0 ? transcriptText || null : null,
              }))
            : [
                {
                  user_id: user.id,
                  image_path: null,
                  text_input: noteText || null,
                  voice_transcript: transcriptText || null,
                },
              ];

          const { data: inserted } = await supabase
            .from("food_evidence")
            .insert(evidenceRows)
            .select("id");
          evidenceIds = (inserted ?? []).map((r) => r.id as string);
        }

        // Tell the client immediately. If the connection drops mid-analysis it
        // still knows what to retry, so the photo is never lost (PRD §37).
        if (evidenceIds.length) send({ type: "evidence", evidenceIds });

        if (!images.length && !noteText && !transcriptText) {
          throw new Error("Nothing to analyze — add a photo or a note.");
        }

        /* ------------------------------------ 2. personal food memory */

        send({ type: "stage", stage: "matching_saved" });

        const { data: saved } = await supabase
          .from("saved_foods")
          .select("*")
          .order("times_logged", { ascending: false })
          .limit(40);

        /* -------------------------------------------- 3. interpret */

        let items: Enriched[] = await analyzeFood({
          images: images.map(({ base64, mime }) => ({ base64, mime })),
          note: noteText,
          transcript: transcriptText,
          savedFoods: (saved ?? []) as SavedFood[],
        });

        /* ------------------ 4. trusted lookups + deterministic math */

        send({ type: "stage", stage: "working_serving" });

        items = await Promise.all(items.map((item) => enrich(item, (saved ?? []) as SavedFood[])));

        /* --------------------------------------------- 5. persist */

        const { data: rows, error: insertError } = await supabase
          .from("food_entries")
          .insert(
            items.map((item) => ({
              user_id: user.id,
              local_date: localDate,
              consumed_at: new Date().toISOString(),
              name: item.name.slice(0, 120),
              calories: item.calories,
              protein_g: item.protein_g,
              carbs_g: item.carbs_g,
              fat_g: item.fat_g,
              quantity: item.quantity,
              unit: item.unit,
              source_type: item.source,
              confidence: item.confidence,
              source_label: item.source_label,
              reasoning: item.reasoning,
              saved_food_id: item.matchedSavedFoodId ?? null,
            })),
          )
          .select("*");

        if (insertError || !rows?.length) {
          throw new Error(insertError?.message ?? "Could not save the entry.");
        }

        const entries = rows as FoodEntry[];

        // Link the stored evidence to the entries it produced. One image maps
        // to one entry when the counts line up; otherwise everything attaches
        // to the first entry so nothing is orphaned.
        if (evidenceIds.length) {
          await Promise.all(
            evidenceIds.map((id, i) =>
              supabase
                .from("food_evidence")
                .update({
                  food_entry_id:
                    evidenceIds.length === entries.length ? entries[i].id : entries[0].id,
                })
                .eq("id", id),
            ),
          );
        }

        // Food memory: remember anything we were confident about (PRD §22).
        await rememberFoods(supabase, items, entries);

        const withPhotos = await attachPhotos(supabase, entries);
        send({ type: "logged", entries: withPhotos, celebrate: false });
      } catch (err) {
        send({
          type: "error",
          message:
            err instanceof Error ? err.message : "Something went wrong reading that.",
          evidenceIds,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

type Enriched = AnalyzedItem & { matchedSavedFoodId?: string | null };

/** Units that mean "this many of the packaged thing", so a database
 *  per-serving figure can be multiplied by the quantity. */
const SERVING_UNITS = new Set([
  "serving", "servings", "container", "containers", "package", "packages",
  "packet", "packets", "bottle", "bottles", "can", "cans", "bar", "bars",
  "piece", "pieces", "unit", "units",
]);
/** Units that mean a mass or volume, so a per-100 figure can be scaled. */
const MASS_UNITS = new Set(["g", "gram", "grams", "ml", "milliliter", "milliliters"]);

/** How many of `hit`'s basis the user consumed, or null when the item's unit
 *  makes that genuinely unknowable. Returning null is the safe answer: the
 *  model's own estimate stands rather than being overwritten by a number
 *  scaled against the wrong basis. */
function scaleFor(hit: SourceHit, item: AnalyzedItem): number | null {
  const q = Number(item.quantity);
  if (!Number.isFinite(q) || q <= 0) return null;
  const unit = (item.unit ?? "").trim().toLowerCase();

  if (hit.basis === "100g") {
    return MASS_UNITS.has(unit) ? q / 100 : null;
  }
  // basis === "serving"
  if (!unit || SERVING_UNITS.has(unit)) return q;
  return null;
}

/** A saved food or a database hit outranks the model's own estimate — but
 *  never a nutrition label the model actually read (PRD §11). */
async function enrich(item: AnalyzedItem, saved: SavedFood[]): Promise<Enriched> {
  const out: Enriched = { ...item, matchedSavedFoodId: null };

  // A. the label the model read is the source of truth, full stop. This check
  //    comes FIRST so no later branch can quietly override it.
  const readALabel = item.source === "nutrition_label" && Boolean(item.serving);

  // B. the user's own library
  const match = item.matched_saved_food_id
    ? saved.find((f) => f.id === item.matched_saved_food_id)
    : undefined;

  if (match && !readALabel) {
    // saved_foods stores the amount actually logged last time (its
    // serving_size describes it), so it is used AS IS. Multiplying by the
    // model's descriptive quantity would double-count a "2 scoops" row.
    // Having more than one is a single tap on Quantity in the edit sheet.
    const portion = match.serving_size ? ` (${match.serving_size})` : "";
    return {
      ...out,
      name: match.name,
      calories: round1(Number(match.calories)),
      protein_g: round1(Number(match.protein_g)),
      carbs_g: round1(Number(match.carbs_g)),
      fat_g: round1(Number(match.fat_g)),
      quantity: 1,
      unit: match.serving_size,
      source: "saved_food",
      confidence: "high",
      source_label: "Saved food · matched from your library",
      reasoning: `Matched a food you've confirmed ${match.times_logged} time${
        Number(match.times_logged) === 1 ? "" : "s"
      }. Using your saved amount${portion} — bump Quantity if you had more.`,
      matchedSavedFoodId: match.id,
    };
  }

  if (readALabel) return out;

  // C. structured nutrition databases
  const hit = item.barcode
    ? await lookupBarcode(item.barcode)
    : item.confidence === "low"
      ? await lookupUsda(item.name)
      : null;

  if (!hit) return out;

  const scale = scaleFor(hit, item);
  if (scale === null) {
    // We found the product but cannot map the amount onto it. Keep the
    // model's estimate; only note the corroboration.
    return out;
  }

  const calories = round1(hit.calories * scale);
  // A scaling slip is the one failure that silently poisons a day's total.
  // Anything implausible for a single item is treated as a miss.
  if (!Number.isFinite(calories) || calories > 5000) return out;

  const providerName =
    hit.provider === "open_food_facts" ? "Open Food Facts" : "USDA FoodData Central";

  return {
    ...out,
    calories,
    protein_g: round1(hit.protein_g * scale),
    carbs_g: round1(hit.carbs_g * scale),
    fat_g: round1(hit.fat_g * scale),
    source: "food_database",
    confidence: item.confidence === "low" ? "medium" : item.confidence,
    source_label:
      hit.provider === "open_food_facts"
        ? "Open Food Facts · matched by barcode"
        : "USDA FoodData Central",
    reasoning: `${item.reasoning} Values come from ${providerName} (${
      hit.basis === "100g" ? "per 100 g" : `per ${hit.serving_size ?? "serving"}`
    }), scaled to what you had.`,
  };
}

type Supa = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/** Confirmed foods become one-tap re-adds. The remember-or-increment is a
 *  single atomic statement (`remember_food`), so two photos of the same food
 *  in one batch can't fork the library — and the loop is sequential for the
 *  same reason. */
async function rememberFoods(
  supabase: Supa,
  items: Enriched[],
  entries: FoodEntry[],
) {
  for (const [i, item] of items.entries()) {
    // A guess isn't worth remembering; it would poison future matches.
    if (item.confidence === "low") continue;

    const { data: savedId, error } = await supabase.rpc("remember_food", {
      p_name: item.name,
      p_calories: item.calories,
      p_protein: item.protein_g,
      p_carbs: item.carbs_g,
      p_fat: item.fat_g,
      p_serving: item.unit ? `${item.quantity} ${item.unit}` : null,
      p_barcode: item.barcode ?? null,
    });

    if (error || !savedId) continue;

    const entry = entries[i] ?? entries[0];
    if (entry) {
      await supabase
        .from("food_entries")
        .update({ saved_food_id: savedId as string })
        .eq("id", entry.id);
    }
  }
}
