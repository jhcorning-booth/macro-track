/** Every number the UI shows is derived here. The model returns per-item
 *  values only; totals, percentages, averages, adherence and correlations are
 *  computed in application code (PRD §16, §36). Pure functions, no I/O — so
 *  they are trivially testable and cannot drift between screens. */

import type {
  AnalyzedItem,
  DailyLog,
  FoodEntry,
  Targets,
  Totals,
  WeightEntry,
} from "./types";
import { addDays, daysBetween } from "./dates";
import { fmt, signed, trim } from "./format";

export const EMPTY_TOTALS: Totals = { cal: 0, p: 0, c: 0, f: 0 };

export function sumEntries(entries: Pick<FoodEntry, "calories" | "protein_g" | "carbs_g" | "fat_g">[]): Totals {
  return entries.reduce<Totals>(
    (a, e) => ({
      cal: a.cal + Number(e.calories),
      p: a.p + Number(e.protein_g),
      c: a.c + Number(e.carbs_g),
      f: a.f + Number(e.fat_g),
    }),
    { ...EMPTY_TOTALS },
  );
}

/* ------------------------------------------------------------ hero gauge */

export interface HeroState {
  /** 0–100, clamped — the gauge never overflows its track. */
  fillPct: number;
  /** "68%" */
  pctLabel: string;
  hit: boolean;
  /** Signed remainder; negative once the target is passed. */
  remaining: number;
  /** "920 kcal left to fill" / "Goal reached · +60 kcal bonus" */
  statusLine: string;
  greeting: string;
}

export function heroState(total: number, target: number): HeroState {
  const safeTarget = target > 0 ? target : 1;
  const pct = Math.min(100, (total / safeTarget) * 100);
  const hit = total >= target && target > 0;
  const remaining = target - total;
  return {
    fillPct: pct,
    pctLabel: `${Math.round(pct)}%`,
    hit,
    remaining,
    statusLine: hit
      ? `Goal reached · +${fmt(total - target)} kcal bonus`
      : `${fmt(remaining)} kcal left to fill`,
    greeting: hit ? "Tank's full" : "Let's fill up",
  };
}

export interface MacroRow {
  key: "p" | "c" | "f";
  label: string;
  /** "199 g / 200 g" — the numeric text always shows the overage. */
  text: string;
  /** Bar width, capped at 100%. */
  pct: number;
  hit: boolean;
  colorVar: string;
}

export function macroRows(totals: Totals, targets: Targets): MacroRow[] {
  const spec = [
    { key: "p" as const, label: "Protein", val: totals.p, tgt: Number(targets.protein_target_g), colorVar: "var(--color-macro-p)" },
    { key: "c" as const, label: "Carbs", val: totals.c, tgt: Number(targets.carbs_target_g), colorVar: "var(--color-macro-c)" },
    { key: "f" as const, label: "Fat", val: totals.f, tgt: Number(targets.fat_target_g), colorVar: "var(--color-macro-f)" },
  ];
  return spec.map(({ key, label, val, tgt, colorVar }) => {
    const hit = tgt > 0 && val >= tgt;
    return {
      key,
      label,
      text: `${trim(val)} g / ${trim(tgt)} g`,
      pct: tgt > 0 ? Math.min(100, (val / tgt) * 100) : 0,
      hit,
      colorVar: hit ? "var(--color-good)" : colorVar,
    };
  });
}

/* --------------------------------------------------------- serving math
   The model reads the label and says how much was consumed; the arithmetic
   happens here so a model slip can't produce an inconsistent entry. */

export function applyServing(item: AnalyzedItem): AnalyzedItem {
  const s = item.serving;
  if (!s || !Number.isFinite(s.servings_consumed)) return item;
  const k = s.servings_consumed;
  return {
    ...item,
    calories: round1(s.label_calories * k),
    protein_g: round1(s.label_protein_g * k),
    carbs_g: round1(s.label_carbs_g * k),
    fat_g: round1(s.label_fat_g * k),
  };
}

/** Edit-sheet quantity stepper: a multiplier applied to the whole entry. */
export function scaleEntry(
  values: { cal: number; p: number; c: number; f: number; quantity: number },
  multiplier: number,
) {
  return {
    calories: round1(values.cal * multiplier),
    protein_g: round1(values.p * multiplier),
    carbs_g: round1(values.c * multiplier),
    fat_g: round1(values.f * multiplier),
    quantity: round2(values.quantity * multiplier),
  };
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* -------------------------------------------------------------- trends */

export interface WindowStats {
  days: number;
  avgCalories: number;
  avgProtein: number;
  avgCarbs: number;
  avgFat: number;
  daysAtTarget: number;
  daysLogged: number;
  adherencePct: number;
  avgTarget: number;
  weightChange: number | null;
}

/** `logs` may be sparse; the window is the last `days` calendar days ending
 *  on `today`. Averages are over days that actually have a food log, so a
 *  missed day doesn't read as a 0-calorie day. */
export function windowStats(
  logs: DailyLog[],
  weights: WeightEntry[],
  today: string,
  days: number,
): WindowStats {
  const from = addDays(today, -(days - 1));
  const inWindow = logs.filter(
    (l) => daysBetween(from, l.local_date) >= 0 && daysBetween(l.local_date, today) >= 0,
  );
  const logged = inWindow.filter((l) => l.entry_count > 0);
  const n = logged.length || 1;

  const sum = logged.reduce(
    (a, l) => ({
      cal: a.cal + Number(l.total_calories),
      p: a.p + Number(l.total_protein_g),
      c: a.c + Number(l.total_carbs_g),
      f: a.f + Number(l.total_fat_g),
      t: a.t + Number(l.calories_target ?? 0),
    }),
    { cal: 0, p: 0, c: 0, f: 0, t: 0 },
  );

  const atTarget = logged.filter((l) => l.calorie_goal_achieved).length;

  return {
    days,
    avgCalories: sum.cal / n,
    avgProtein: sum.p / n,
    avgCarbs: sum.c / n,
    avgFat: sum.f / n,
    daysAtTarget: atTarget,
    daysLogged: logged.length,
    // Adherence is measured against the whole window, not only logged days —
    // an unlogged day is not a day at target.
    adherencePct: days > 0 ? (atTarget / days) * 100 : 0,
    avgTarget: logged.length ? sum.t / n : 0,
    weightChange: weightDelta(weights, today, days),
  };
}

/** Change in the 7-day rolling average across the window — resistant to the
 *  day-to-day noise a raw first-vs-last comparison would amplify (PRD §28). */
export function weightDelta(
  weights: WeightEntry[],
  today: string,
  days: number,
): number | null {
  const series = rollingWeight(weights, 7);
  if (series.length < 2) return null;
  const from = addDays(today, -(days - 1));
  const inWindow = series.filter(
    (p) => daysBetween(from, p.date) >= 0 && daysBetween(p.date, today) >= 0,
  );
  if (inWindow.length < 2) return null;
  return round1(inWindow[inWindow.length - 1].avg - inWindow[0].avg);
}

export interface RollingPoint {
  date: string;
  raw: number;
  avg: number;
}

/** Trailing moving average over the last `n` recorded weights. */
export function rollingWeight(weights: WeightEntry[], n = 7): RollingPoint[] {
  const sorted = [...weights].sort((a, b) => a.local_date.localeCompare(b.local_date));
  return sorted.map((w, i) => {
    const win = sorted.slice(Math.max(0, i - (n - 1)), i + 1);
    const avg = win.reduce((s, x) => s + Number(x.weight), 0) / win.length;
    return { date: w.local_date, raw: Number(w.weight), avg: round1(avg) };
  });
}

export interface WeightSummary {
  current: number | null;
  avg7: number | null;
  avg30: number | null;
  weeklyChange: number | null;
}

export function weightSummary(weights: WeightEntry[], today: string): WeightSummary {
  const sorted = [...weights].sort((a, b) => a.local_date.localeCompare(b.local_date));
  if (!sorted.length) return { current: null, avg7: null, avg30: null, weeklyChange: null };

  const mean = (xs: WeightEntry[]) =>
    xs.length ? round1(xs.reduce((s, x) => s + Number(x.weight), 0) / xs.length) : null;

  const within = (d: number) =>
    sorted.filter((w) => daysBetween(w.local_date, today) < d && daysBetween(w.local_date, today) >= 0);

  return {
    current: Number(sorted[sorted.length - 1].weight),
    avg7: mean(within(7)),
    avg30: mean(within(30)),
    weeklyChange: weightDelta(sorted, today, 7),
  };
}

/* ---------------------------------------------------------- correlation
   Compares 7-day rolling average calories against 7-day rolling average
   weight over several weeks. Deliberately descriptive — the copy never
   claims causation (PRD §31). */

export interface Correlation {
  available: boolean;
  headline: string;
  body: string;
}

export function correlation(
  logs: DailyLog[],
  weights: WeightEntry[],
  today: string,
  weeks = 4,
): Correlation {
  const span = weeks * 7;
  const from = addDays(today, -(span - 1));
  const logged = logs
    .filter((l) => l.entry_count > 0 && daysBetween(from, l.local_date) >= 0)
    .sort((a, b) => a.local_date.localeCompare(b.local_date));
  const wSeries = rollingWeight(weights, 7).filter((p) => daysBetween(from, p.date) >= 0);

  if (logged.length < 10 || wSeries.length < 10) {
    return {
      available: false,
      headline: "Pattern, not proof",
      body: `Keep logging — once there are a few weeks of food and weight in the same window, this card compares your 7-day average intake against your 7-day average weight.`,
    };
  }

  const half = Math.floor(logged.length / 2);
  const avg = (xs: DailyLog[]) => xs.reduce((s, l) => s + Number(l.total_calories), 0) / xs.length;
  const calFirst = avg(logged.slice(0, half));
  const calLast = avg(logged.slice(half));
  const wFirst = wSeries[0].avg;
  const wLast = wSeries[wSeries.length - 1].avg;
  const wDelta = round1(wLast - wFirst);

  const calMoved = Math.abs(calLast - calFirst) >= 75;
  const weightMoved = Math.abs(wDelta) >= 0.5;

  const intake = calMoved
    ? `Your average intake moved from ${fmt(calFirst)} to ${fmt(calLast)} kcal/day over ${weeks} weeks`
    : `Your average intake held around ${fmt(calLast)} kcal/day over ${weeks} weeks`;

  const weight = weightMoved
    ? `while your 7-day average weight ${wDelta > 0 ? "rose" : "fell"} ${Math.abs(wDelta).toFixed(1)} lb`
    : `while your 7-day average weight stayed within half a pound`;

  const closer =
    calMoved && weightMoved && Math.sign(calLast - calFirst) === Math.sign(wDelta)
      ? "The two are moving together — hold the surplus steady another two weeks and we'll see if it keeps up."
      : calMoved || weightMoved
        ? "They aren't tracking each other yet. Another two weeks of steady logging will make the picture clearer."
        : "Steady on both counts. Nothing to read into yet.";

  return {
    available: true,
    headline: "Pattern, not proof",
    body: `${intake} ${weight}. ${closer}`,
  };
}

/* ---------------------------------------------------------- chart shapes */

export interface CalBar {
  date: string;
  /** Weekday initial. */
  day: string;
  calories: number;
  target: number;
  /** 0–100 height against a ceiling derived from the data. */
  heightPct: number;
  atTarget: boolean;
}

const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

/** Plot ceiling. Shared by the bars and the target rule so the labelled line
 *  can never land at a height that means a different number. */
export function barCeiling(bars: CalBar[], currentTarget: number): number {
  return Math.max(
    3200,
    currentTarget * 1.25,
    ...bars.map((b) => b.calories * 1.08),
    ...bars.map((b) => b.target * 1.25),
  );
}

/** `currentTarget` is the target in force today — the one the card's header
 *  labels. Per-day historical targets still decide each bar's colour. */
export function calorieBars(
  logs: DailyLog[],
  today: string,
  days: number,
  currentTarget: number,
): CalBar[] {
  const byDate = new Map(logs.map((l) => [l.local_date, l]));
  const out: CalBar[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const l = byDate.get(date);
    const cal = Number(l?.total_calories ?? 0);
    const tgt = Number(l?.calories_target ?? 0);
    const [y, m, d] = date.split("-").map(Number);
    out.push({
      date,
      day: DAY_INITIALS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()],
      calories: cal,
      target: tgt,
      heightPct: 0,
      atTarget: tgt > 0 && cal >= tgt,
    });
  }
  const ceiling = barCeiling(out, currentTarget);
  return out.map((b) => ({
    ...b,
    heightPct: Math.max(b.calories > 0 ? 6 : 2, Math.min(100, (b.calories / ceiling) * 100)),
  }));
}

/** Where the dashed rule sits, as a % from the bottom. Positioned from the
 *  SAME target the card's header prints — a rule drawn at a day's historical
 *  target under a label naming today's would be quietly wrong. */
export function targetLinePct(bars: CalBar[], currentTarget: number): number {
  if (!currentTarget) return 0;
  return Math.min(94, (currentTarget / barCeiling(bars, currentTarget)) * 100);
}

/** SVG polyline points for the weight card, scaled to the data's own range. */
export function weightPolylines(
  points: RollingPoint[],
  width = 300,
  height = 100,
): { raw: string; avg: string } {
  if (points.length < 2) return { raw: "", avg: "" };
  const values = points.flatMap((p) => [p.raw, p.avg]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pad = span * 0.15;
  const min = lo - pad;
  const range = span + pad * 2;

  const toPts = (get: (p: RollingPoint) => number) =>
    points
      .map((p, i) => {
        const x = (i / (points.length - 1)) * width;
        const y = height - ((get(p) - min) / range) * (height * 0.9);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return { raw: toPts((p) => p.raw), avg: toPts((p) => p.avg) };
}

export function weightChangeLabel(points: RollingPoint[], weeks = 4): string | null {
  if (points.length < 2) return null;
  const delta = round1(points[points.length - 1].avg - points[0].avg);
  return `${signed(delta)} lb / ${weeks} wk`;
}
