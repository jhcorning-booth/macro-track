import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import * as z from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AnalyzedItem, SavedFood } from "./types";
import { applyServing, round1 } from "./calc";

/** The model is an interpreter, not the database or the calculator (PRD §36).
 *  It reads evidence and reports per-item structured values plus, when a label
 *  is legible, the raw label figures and how many servings were consumed —
 *  the multiplication happens in `applyServing`, not in the model. */

const MODEL = process.env.MACROTRACK_MODEL ?? "claude-opus-5";
/** Measured on a legible label: low and medium are indistinguishable on
 *  latency (the variance is connection warm-up, not reasoning) and both read
 *  it correctly, so medium is kept for the hard case this is really for —
 *  estimating an unlabelled mixed plate, which the PRD calls out as the
 *  largest source of uncertainty (§43). Costs about half a cent more per log.
 *  Set MACROTRACK_EFFORT=low to trade that back. */
const EFFORT = (process.env.MACROTRACK_EFFORT ?? "medium") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const ItemSchema = z.object({
  name: z
    .string()
    .describe("Short, human food name as it should appear in the log."),
  quantity: z.number().describe("How much was consumed, as a number."),
  unit: z
    .string()
    .nullable()
    .describe('Unit for quantity, e.g. "scoops", "g", "container", "plate".'),
  calories: z.number().describe("Consumed kcal. Ignored when `serving` is present."),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  source: z.enum([
    "nutrition_label",
    "saved_food",
    "food_database",
    "visual_estimate",
    "text_only",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
  source_label: z
    .string()
    .describe(
      'Short provenance line shown under the name, e.g. "Nutrition label + your note".',
    ),
  reasoning: z
    .string()
    .describe(
      "Two sentences max, plain language, addressed to the user, explaining how the number was reached.",
    ),
  serving: z
    .object({
      label_calories: z.number(),
      label_protein_g: z.number(),
      label_carbs_g: z.number(),
      label_fat_g: z.number(),
      servings_consumed: z
        .number()
        .describe(
          "Fraction or multiple of ONE label serving that was actually eaten.",
        ),
    })
    .nullable()
    .describe(
      "Only when a nutrition label was legible. Give the label's own per-serving figures untouched; the app multiplies.",
    ),
  barcode: z.string().nullable(),
  matched_saved_food_id: z
    .string()
    .nullable()
    .describe("id of the saved food this matches, copied exactly, or null."),
});

const ResultSchema = z.object({
  items: z.array(ItemSchema),
});

const SYSTEM = `You are the nutrition-extraction step of a photo-first calorie tracker. You interpret evidence; the application does all arithmetic and storage.

EVIDENCE HIERARCHY — use the strongest available, in this order:
1. A readable nutrition label in the photo. This is the source of truth. Report the label's own per-serving numbers in the "serving" object and set servings_consumed to how much the user actually ate. Do NOT pre-multiply.
2. The user's own words (typed note or voice transcript). These override your assumptions about amount: "I only ate half" -> servings_consumed 0.5; "two scoops" against a 4-scoop label serving -> 0.5; "about 70%" -> 0.7; "two bottles" -> 2.
3. A saved food from the user's library that clearly matches. Copy its values exactly, set source "saved_food", confidence "high", and put its id in matched_saved_food_id.
4. A recognizable packaged product. If you can read a barcode, report it; the app will look it up.
5. Visual estimation, last. Identify the food, preparation, likely portion, and major ingredients, then estimate.

ONE IMAGE = ONE FOOD ITEM. Never merge two photographs into a single record, even if they look like the same food. If a single photo shows one composed plate (protein + starch + vegetable), that is still one item — name the dish, don't split it into ingredients. If a single photo genuinely shows several separately-eaten items (three packaged bars laid out), you may return one item per distinct food.

If there are no images, work from the text alone and set source "text_only". Text may describe several foods ("two eggs and two slices of toast") — return one item per food.

CONFIDENCE
- high: readable label, exact saved-food match, or a product whose published nutrition you are certain of.
- medium: identifiable packaged food without a legible label; a restaurant item with well-known nutrition.
- low: visual estimate, unclear portion, mixed dish.
Never inflate confidence. A low-confidence estimate is still logged — it is labeled, not blocked.

REASONING is shown to the user in their own log. Write it warmly and concretely, in at most two sentences: what you read, what you assumed, and which part is least certain. Never apologize, never hedge into uselessness.

NUMBERS
- Calories in kcal, macros in grams; one decimal place at most.
- Never return day totals, running totals, or anything about targets.
- If a nutrition label is legible, ALWAYS fill in "serving" rather than doing the multiplication yourself.
- Prefer being roughly right over refusing. There is always an answer; the user can correct it in one tap.`;

function mediaType(mime: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  if (mime.includes("png")) return "image/png";
  if (mime.includes("webp")) return "image/webp";
  if (mime.includes("gif")) return "image/gif";
  return "image/jpeg";
}

export interface AnalyzeInput {
  images: { base64: string; mime: string }[];
  note: string;
  transcript: string;
  savedFoods: SavedFood[];
}

export async function analyzeFood(input: AnalyzeInput): Promise<AnalyzedItem[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — add it to .env.local to enable photo analysis.",
    );
  }

  const client = new Anthropic({ apiKey });

  const content: Anthropic.ContentBlockParam[] = [];

  input.images.forEach((img, i) => {
    content.push({
      type: "text",
      text: `Image ${i + 1} of ${input.images.length} — treat as its own food item:`,
    });
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType(img.mime), data: img.base64 },
    });
  });

  const said = [
    input.note && `Typed note: "${input.note}"`,
    input.transcript && `Said out loud: "${input.transcript}"`,
  ]
    .filter(Boolean)
    .join("\n");

  if (said) content.push({ type: "text", text: said });
  else if (input.images.length) {
    content.push({
      type: "text",
      text: "The user added no note. Assume one standard serving of what you see unless the packaging says otherwise.",
    });
  }

  if (input.savedFoods.length) {
    const library = input.savedFoods
      .map(
        (f) =>
          `- id=${f.id} | ${f.name} | ${Number(f.calories)} kcal, ${Number(f.protein_g)}P ${Number(f.carbs_g)}C ${Number(f.fat_g)}F` +
          (f.serving_size ? ` | serving: ${f.serving_size}` : "") +
          ` | logged ${f.times_logged}×`,
      )
      .join("\n");
    content.push({
      type: "text",
      text: `The user's saved foods — check these before estimating:\n${library}`,
    });
  }

  if (!content.length) throw new Error("Nothing to analyze.");

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { effort: EFFORT, format: zodOutputFormat(ResultSchema) },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The analyzer declined this photo. Log it by hand instead.");
  }

  const parsed = response.parsed_output;
  if (!parsed?.items?.length) {
    throw new Error("Couldn't identify any food in that.");
  }

  // Serving arithmetic happens here, never in the model.
  return parsed.items.map((item) => {
    const applied = applyServing(item as AnalyzedItem);
    return {
      ...applied,
      calories: round1(Math.max(0, applied.calories)),
      protein_g: round1(Math.max(0, applied.protein_g)),
      carbs_g: round1(Math.max(0, applied.carbs_g)),
      fat_g: round1(Math.max(0, applied.fat_g)),
      quantity: Number.isFinite(applied.quantity) && applied.quantity > 0 ? applied.quantity : 1,
    };
  });
}
