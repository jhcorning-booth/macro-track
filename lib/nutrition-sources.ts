import "server-only";

/** Trusted nutrition lookups, tried before the model's own estimate is
 *  accepted (PRD §11). A hit upgrades confidence; a miss is a no-op — the
 *  pipeline never blocks on these. */

export interface SourceHit {
  name: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  /** What the numbers above are FOR. The caller cannot scale safely without
   *  this — treating per-100 g figures as per-serving is a ~10x error. */
  basis: "serving" | "100g";
  serving_size: string | null;
  provider: "open_food_facts" | "usda";
}

const TIMEOUT_MS = 3500;

async function getJson(url: string, headers?: HeadersInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MacroTrack-AI/1.0 (personal use)", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Open Food Facts, keyed by barcode. Prefers per-serving values; falls back
 *  to per-100 g, which the caller scales by the grams the model reported. */
export async function lookupBarcode(barcode: string): Promise<SourceHit | null> {
  const clean = barcode.replace(/\D/g, "");
  if (clean.length < 8) return null;

  const data = (await getJson(
    `https://world.openfoodfacts.org/api/v2/product/${clean}.json?fields=product_name,brands,serving_size,nutriments`,
  )) as
    | {
        status?: number;
        product?: {
          product_name?: string;
          brands?: string;
          serving_size?: string;
          nutriments?: Record<string, unknown>;
        };
      }
    | null;

  const p = data?.product;
  const n = p?.nutriments;
  if (!p || !n) return null;

  const perServing =
    num(n["energy-kcal_serving"]) !== null &&
    num(n["proteins_serving"]) !== null;

  const kcal = perServing ? num(n["energy-kcal_serving"]) : num(n["energy-kcal_100g"]);
  if (kcal === null) return null;

  const suffix = perServing ? "_serving" : "_100g";
  return {
    name: [p.brands?.split(",")[0]?.trim(), p.product_name].filter(Boolean).join(" ").trim() ||
      p.product_name ||
      "Packaged food",
    calories: kcal,
    protein_g: num(n[`proteins${suffix}`]) ?? 0,
    carbs_g: num(n[`carbohydrates${suffix}`]) ?? 0,
    fat_g: num(n[`fat${suffix}`]) ?? 0,
    basis: perServing ? "serving" : "100g",
    serving_size: perServing ? (p.serving_size ?? null) : "100 g",
    provider: "open_food_facts",
  };
}

/** USDA FoodData Central. Only runs when a key is configured; the free key is
 *  optional and the pipeline degrades to visual estimation without it. */
export async function lookupUsda(query: string): Promise<SourceHit | null> {
  const key = process.env.USDA_API_KEY;
  if (!key || query.trim().length < 3) return null;

  const data = (await getJson(
    `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}` +
      `&query=${encodeURIComponent(query)}&pageSize=1&dataType=Branded,SR%20Legacy,Foundation`,
  )) as
    | {
        foods?: {
          description?: string;
          servingSize?: number;
          servingSizeUnit?: string;
          foodNutrients?: { nutrientNumber?: string; value?: number }[];
        }[];
      }
    | null;

  const food = data?.foods?.[0];
  if (!food?.foodNutrients) return null;

  // USDA nutrient numbers: 208 kcal, 203 protein, 205 carbs, 204 fat.
  const by = (code: string) =>
    num(food.foodNutrients?.find((x) => x.nutrientNumber === code)?.value) ?? 0;

  const kcal = by("208");
  if (!kcal) return null;

  // FDC nutrient values are per 100 g for every dataType we request.
  return {
    name: food.description ?? query,
    calories: kcal,
    protein_g: by("203"),
    carbs_g: by("205"),
    fat_g: by("204"),
    basis: "100g",
    serving_size:
      food.servingSize && food.servingSizeUnit
        ? `${food.servingSize} ${food.servingSizeUnit}`
        : "100 g",
    provider: "usda",
  };
}
