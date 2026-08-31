/** Turns body inputs into a starting calorie and macro target.
 *
 *  This is an estimate, not advice — the PRD lists medical nutrition
 *  recommendations as a non-goal (§5), and the UI says so. What that means in
 *  code: the result is never applied automatically, every clamp that fires is
 *  reported back so the screen can explain itself, and the floors below are
 *  not negotiable by input.
 *
 *  Mifflin-St Jeor for BMR — better validated on a general adult population
 *  than Harris-Benedict — then an activity multiplier for TDEE, then a gap
 *  toward the goal weight at a safe pace. */

export type Sex = "female" | "male" | "unspecified";
export type ActivityLevel = "sedentary" | "light" | "active" | "very_active";

export interface BodyInputs {
  sex: Sex;
  age: number;
  heightCm: number;
  weightKg: number;
  goalWeightKg: number;
  activity: ActivityLevel;
}

export interface Recommendation {
  bmr: number;
  tdee: number;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  /** gain | lose | maintain — also what the Today header's goal label reads. */
  direction: "gain" | "lose" | "maintain";
  goalLabel: string;
  /** The weight this was computed against. Carried so the caller can record
   *  it and later notice the real weight has drifted away from the plan. */
  basisWeightKg: number;
  /** kg per week actually being pursued after clamping. */
  paceKgPerWeek: number;
  /** Whole weeks to reach the goal at that pace; null when maintaining. */
  weeksToGoal: number | null;
  /** Every guard that fired, in plain language, for the UI to show. */
  notes: string[];
}

export const ACTIVITY: Record<ActivityLevel, { factor: number; label: string; hint: string }> = {
  sedentary: { factor: 1.2, label: "Sedentary", hint: "Desk job, little exercise" },
  light: { factor: 1.375, label: "Lightly active", hint: "Light exercise 1–3 days a week" },
  active: { factor: 1.55, label: "Active", hint: "Moderate exercise 3–5 days a week" },
  very_active: { factor: 1.725, label: "Very active", hint: "Hard exercise 6–7 days a week" },
};

/** Floors. A recommendation must never go below the user's own BMR, nor below
 *  these absolute numbers, whatever goal weight is entered. */
const ABSOLUTE_FLOOR: Record<Sex, number> = {
  female: 1200,
  male: 1500,
  unspecified: 1350,
};

/** Cap on how fast to pursue the goal, as a fraction of body weight per week.
 *  Gaining is capped tighter: a fast surplus is mostly fat. */
const MAX_LOSS_FRACTION = 0.01;
const MAX_GAIN_FRACTION = 0.005;
/** Default pace when the cap isn't binding: ~0.45 kg (1 lb) a week down,
 *  half that up. */
const DEFAULT_LOSS_KG_WEEK = 0.45;
const DEFAULT_GAIN_KG_WEEK = 0.225;

/** 7,700 kcal per kg of body mass — the conventional figure. */
const KCAL_PER_KG = 7700;

const round = (n: number, to: number) => Math.round(n / to) * to;

export function bmrOf({ sex, age, heightCm, weightKg }: Omit<BodyInputs, "goalWeightKg" | "activity">): number {
  // Mifflin-St Jeor: 10W + 6.25H − 5A, then +5 for male / −161 for female.
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  if (sex === "male") return base + 5;
  if (sex === "female") return base - 161;
  // Unspecified: the midpoint, rather than refusing to produce a number.
  return base - 78;
}

export function recommend(input: BodyInputs): Recommendation {
  const notes: string[] = [];
  const { sex, age, heightCm, weightKg, goalWeightKg, activity } = input;

  if (age < 18 || age > 80) {
    notes.push(
      "This formula was validated on adults 18–80, so treat the number as rougher than usual.",
    );
  }

  const goalBmi = goalWeightKg / (heightCm / 100) ** 2;
  if (goalBmi < 16 || goalBmi > 45) {
    notes.push(
      "That goal weight is well outside the usual range for your height — worth a second look, and worth talking to a doctor about.",
    );
  }

  const bmr = bmrOf({ sex, age, heightCm, weightKg });
  const tdee = bmr * ACTIVITY[activity].factor;

  const deltaKg = goalWeightKg - weightKg;
  const direction = Math.abs(deltaKg) < 0.5 ? "maintain" : deltaKg > 0 ? "gain" : "lose";

  let paceKgPerWeek = 0;
  if (direction === "lose") {
    const cap = weightKg * MAX_LOSS_FRACTION;
    paceKgPerWeek = -Math.min(DEFAULT_LOSS_KG_WEEK, cap);
    if (DEFAULT_LOSS_KG_WEEK > cap) {
      notes.push("Pace eased to 1% of body weight a week, which is as fast as is sensible.");
    }
  } else if (direction === "gain") {
    const cap = weightKg * MAX_GAIN_FRACTION;
    paceKgPerWeek = Math.min(DEFAULT_GAIN_KG_WEEK, cap);
  }

  const dailyGap = (paceKgPerWeek * KCAL_PER_KG) / 7;
  let calories = tdee + dailyGap;

  // Floors, in order of severity, each reported so the screen can explain.
  const floor = Math.max(Math.round(bmr), ABSOLUTE_FLOOR[sex]);
  if (calories < floor) {
    calories = floor;
    notes.push(
      `Held at ${Math.round(floor)} kcal — going lower than that isn't a trade worth making. Reaching your goal will just take longer.`,
    );
  }

  calories = round(calories, 10);

  // Protein anchors to the goal weight: it is the weight being built toward or
  // preserved, and anchoring to a high current weight over-prescribes.
  const proteinAnchorKg = direction === "lose" ? Math.min(goalWeightKg, weightKg) : goalWeightKg;
  let protein = 2.2 * proteinAnchorKg;
  const proteinCeiling = (calories * 0.4) / 4;
  if (protein > proteinCeiling) {
    protein = proteinCeiling;
    notes.push("Protein capped at 40% of calories so there's room for the rest.");
  }
  const protein_g = round(protein, 5);

  const fat_g = round((calories * 0.25) / 9, 5);
  const carbs_g = Math.max(0, round((calories - protein_g * 4 - fat_g * 9) / 4, 5));

  const weeksToGoal =
    direction === "maintain" || paceKgPerWeek === 0
      ? null
      : Math.max(1, Math.ceil(Math.abs(deltaKg / paceKgPerWeek)));

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    basisWeightKg: weightKg,
    calories,
    protein_g,
    carbs_g,
    fat_g,
    direction,
    goalLabel:
      direction === "gain" ? "lean bulk" : direction === "lose" ? "cutting" : "maintaining",
    paceKgPerWeek,
    weeksToGoal,
    notes,
  };
}

/** Age from a birth year. Year-only, so it is accurate to within a birthday —
 *  which is far finer than this estimate needs. */
export function ageFromBirthYear(birthYear: number, now = new Date()): number {
  return now.getUTCFullYear() - birthYear;
}
