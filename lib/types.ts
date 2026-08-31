/** Shared shapes. These mirror the DB columns 1:1 so nothing is translated twice. */

export type Confidence = "high" | "medium" | "low";

export type SourceType =
  | "nutrition_label"
  | "saved_food"
  | "food_database"
  | "visual_estimate"
  | "text_only"
  | "manual"
  | "quick_add"
  | "history_readd";

export type NudgeKind =
  | "no_logging"
  | "calories_remaining"
  | "target_reached"
  | "protein_checkin"
  | "evening_nudge";

export interface Profile {
  id: string;
  timezone: string;
  weight_unit: "lb" | "kg";
  height_unit: "cm" | "ft_in";
  goal_label: string;
  onboarded_at: string | null;
  created_at: string;

  /* Inputs to the calorie recommendation. Stored only so the setup can be
     reopened and edited — they drive that estimate and nothing else. All
     nullable: the app is fully usable without ever entering any of them. */
  birth_year: number | null;
  sex: "female" | "male" | "unspecified" | null;
  height_cm: number | null;
  activity_level: "sedentary" | "light" | "active" | "very_active" | null;
  goal_weight_kg: number | null;
  /** The weight the last recommendation was computed against, so Settings can
   *  notice drift and offer to redo it — never change the target on its own. */
  plan_basis_weight_kg: number | null;
  plan_computed_at: string | null;
}

export interface Targets {
  calories_target: number;
  protein_target_g: number;
  carbs_target_g: number;
  fat_target_g: number;
}

export interface NutritionTarget extends Targets {
  id: string;
  user_id: string;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
}

export interface FoodEntry {
  id: string;
  user_id: string;
  local_date: string;
  consumed_at: string;
  name: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  quantity: number;
  unit: string | null;
  source_type: SourceType;
  confidence: Confidence;
  source_label: string | null;
  reasoning: string | null;
  notes: string | null;
  saved_food_id: string | null;
  created_at: string;
  updated_at: string;
  /** Signed URL for the first piece of photo evidence, when the entry has one. */
  photo_url?: string | null;
}

export interface SavedFood {
  id: string;
  user_id: string;
  name: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  serving_size: string | null;
  barcode: string | null;
  times_logged: number;
  last_used: string;
  created_at: string;
}

export interface WeightEntry {
  id: string;
  user_id: string;
  local_date: string;
  weight: number;
  unit: "lb" | "kg";
  notes: string | null;
  created_at: string;
}

/** Row of the derived `daily_logs` view — never written directly. */
export interface DailyLog {
  user_id: string;
  local_date: string;
  total_calories: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
  entry_count: number;
  calories_target: number | null;
  protein_target_g: number | null;
  carbs_target_g: number | null;
  fat_target_g: number | null;
  calorie_goal_achieved: boolean;
  weight: number | null;
  weight_unit: "lb" | "kg" | null;
}

export interface NudgePref {
  kind: NudgeKind;
  enabled: boolean;
  send_at: string;
}

export interface Totals {
  cal: number;
  p: number;
  c: number;
  f: number;
}

/* ------------------------------------------------------------ AI pipeline */

/** One item as returned by the model. The model NEVER returns day totals. */
export interface AnalyzedItem {
  name: string;
  quantity: number;
  unit: string | null;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  source: SourceType;
  confidence: Confidence;
  source_label: string;
  reasoning: string;
  /** Present when the model read a label; the app does the serving math. */
  serving?: {
    label_calories: number;
    label_protein_g: number;
    label_carbs_g: number;
    label_fat_g: number;
    /** How many label servings the user actually consumed. */
    servings_consumed: number;
  } | null;
  barcode?: string | null;
  /** id of a SavedFood the model matched this to, or null. */
  matched_saved_food_id?: string | null;
}

/** Where an account stands against its trial. The database is the authority
 *  (public.trial_status); this is only the shape it returns. */
export interface TrialStatus {
  plan: "trial" | "paid" | "owner";
  unlimited: boolean;
  blocked: boolean;
  reason?: "expired" | "quota" | null;
  days_left?: number;
  trial_days?: number;
  analyses_used: number;
  analyses_limit?: number;
  analyses_left?: number;
  expires_at?: string;
  contact_email: string;
}

/** Server-sent events emitted by /api/analyze so the overlay tracks real work. */
export type AnalyzeStage =
  | "reading_label"
  | "matching_saved"
  | "working_serving"
  | "logged";

export type AnalyzeEvent =
  /** Sent as soon as the uploads are stored, so a mid-stream failure still
   *  leaves the client able to retry without re-photographing. */
  | { type: "evidence"; evidenceIds: string[] }
  | { type: "stage"; stage: AnalyzeStage }
  | { type: "logged"; entries: FoodEntry[]; celebrate: boolean }
  | { type: "error"; message: string; evidenceIds: string[] }
  /** Trial exhausted — the UI shows the upgrade wall, not an error toast. */
  | { type: "blocked"; status: TrialStatus };
