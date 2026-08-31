"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/store";
import { StatCard } from "@/components/ui";
import { fmt, g, trim } from "@/lib/format";
import {
  ACTIVITY,
  ageFromBirthYear,
  recommend,
  type ActivityLevel,
  type Sex,
} from "@/lib/recommend";
import {
  cmToFeetInches,
  feetInchesToCm,
  formatWeightDelta,
  weightIn,
  weightToKg,
  type HeightUnit,
  type WeightUnit,
} from "@/lib/units";
import type { Profile, WeightEntry } from "@/lib/types";

/* --------------------------------------------------------------- constants
   Nothing here is required. The app is fully usable by someone who never opens
   this section, and nothing below moves a target until the button at the
   bottom is pressed. */

const SAVE_DEBOUNCE_MS = 600;

/** Explicit, because the order on screen is a design decision — not whatever
 *  order the ACTIVITY object literal happens to be written in. */
const ACTIVITY_ORDER: ActivityLevel[] = ["sedentary", "light", "active", "very_active"];

const SEX_OPTIONS: { value: Sex; label: string }[] = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  // "unspecified" is a real answer to the formula, which averages the two —
  // never a blocked state.
  { value: "unspecified", label: "Prefer not to say" },
];

const WEIGHT_UNITS: { value: WeightUnit; label: string }[] = [
  { value: "lb", label: "lb" },
  { value: "kg", label: "kg" },
];

const HEIGHT_UNITS: { value: HeightUnit; label: string }[] = [
  { value: "ft_in", label: "ft / in" },
  { value: "cm", label: "cm" },
];

/* Sanity windows. Outside them a field reads as "not filled in yet" rather
   than feeding a nonsense number into the formula. */
const AGE_MIN = 1;
const AGE_MAX = 120;
const CM_MIN = 50;
const CM_MAX = 275;
const FEET_MIN = 1;
const FEET_MAX = 8;
const KG_MIN = 20;
const KG_MAX = 400;

const CARD = "rounded-[18px] border border-line bg-raised px-4 py-3.5";
const HINT = "mt-1 text-[11.5px] leading-[1.45] text-faint";
const SUB_LABEL =
  "w-[46px] flex-none text-[10px] font-semibold uppercase tracking-[0.09em] text-faint";

/* ----------------------------------------------------------------- helpers */

function parseNum(text: string): number | null {
  const n = Number.parseFloat(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function inRange(n: number | null, min: number, max: number): number | null {
  return n !== null && n >= min && n <= max ? n : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "age, height, and goal weight" — for the quiet line that stands in place of
 *  a half-computed number. */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** The most recent logged weight, in canonical kilograms. Each row carries the
 *  unit it was logged under, so a log spanning a unit change still reads
 *  correctly. numeric() columns can arrive from PostgREST as strings. */
function latestWeightKg(weights: WeightEntry[]): number | null {
  if (!weights.length) return null;
  const sorted = [...weights].sort((a, b) => a.local_date.localeCompare(b.local_date));
  const last = sorted[sorted.length - 1];
  const n = Number(last.weight);
  if (!Number.isFinite(n) || n <= 0) return null;
  return weightToKg(n, last.unit);
}

/** Same caution for the profile's own numeric() columns. */
function col(value: number | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* -------------------------------------------------------------- primitives */

/** Two-way switch, matching the Trends window control. */
function Segmented<T extends string>({
  ariaLabel,
  value,
  options,
  disabled = false,
  onPick,
}: {
  ariaLabel: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onPick: (v: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex rounded-full bg-[oklch(0.955_0.012_80)] p-[3px]"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onPick(o.value)}
            className={`flex-1 rounded-full py-2 text-[12.5px] font-bold transition-colors disabled:opacity-60 ${
              active ? "bg-raised-soft text-ink shadow-seg" : "text-[oklch(0.55_0.02_65)]"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Wrapping pills, for a set whose labels are too uneven to share a track —
 *  "Prefer not to say" cannot live in a third of a 392px row. */
function ChipGroup<T extends string>({
  ariaLabel,
  value,
  options,
  onPick,
}: {
  ariaLabel: string;
  value: T | null;
  options: { value: T; label: string }[];
  onPick: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onPick(o.value)}
            className={`rounded-full border px-3.5 py-2 text-[12.5px] font-bold transition-colors ${
              active
                ? "border-accent-wash-line bg-accent-wash text-ink"
                : "border-line bg-sunken text-muted"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function NumberField({
  id,
  ariaLabel,
  value,
  suffix,
  width,
  onChange,
}: {
  id: string;
  ariaLabel: string;
  value: string;
  suffix: string;
  width: number;
  onChange: (text: string) => void;
}) {
  return (
    <span className="flex flex-none items-center gap-1.5">
      <input
        id={id}
        inputMode="decimal"
        aria-label={ariaLabel}
        value={value}
        maxLength={6}
        placeholder="—"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onChange(e.target.value)}
        className="tnum rounded-[11px] border border-line-chip bg-sunken px-2.5 py-[7px] text-right font-mono text-[15px] font-bold outline-none placeholder:font-normal placeholder:text-disabled focus:border-accent-wash-line"
        style={{ width }}
      />
      <span className="min-w-[20px] font-mono text-[11.5px] text-muted">{suffix}</span>
    </span>
  );
}

/** A card whose control shares the line with its label. */
function FieldRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="min-w-0 text-[13.5px] font-bold">
          {label}
        </label>
        <span className="flex flex-none items-center gap-2">{children}</span>
      </div>
      {hint && <div className={HINT}>{hint}</div>}
    </div>
  );
}

/** A card whose control sits under its label — switches and option lists. */
function FieldBlock({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={CARD}>
      <div className="text-[13.5px] font-bold">{label}</div>
      {hint && <div className={HINT}>{hint}</div>}
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------- calculator */

/** The setup calculator, whole. It stands alone: no title, no page padding, no
 *  screen chrome — Settings drops it into a section, onboarding drops it into
 *  a step, and neither has to undo anything. */
export function SetupCalculator({ onDone }: { onDone?: () => void }) {
  const { profile, weights, targets, saveProfile, applyRecommendation } = useApp();
  const uid = useId();

  /* ---- units. App-wide preferences, so they are written the moment they are
     tapped rather than riding along with anything else on this form. The
     pending value keeps the control and the numbers moving together while the
     write is in flight. */

  const [pendingWeightUnit, setPendingWeightUnit] = useState<WeightUnit | null>(null);
  const [pendingHeightUnit, setPendingHeightUnit] = useState<HeightUnit | null>(null);
  const weightUnit = pendingWeightUnit ?? profile.weight_unit;
  const heightUnit = pendingHeightUnit ?? profile.height_unit;

  /* ---- draft fields. Seeded once from the profile — and, for current weight,
     from the weight log, which is almost certainly the answer. Held as text,
     not numbers, so a half-typed "63." survives the next keystroke. */

  const [sex, setSex] = useState<Sex | null>(profile.sex);
  const [activity, setActivity] = useState<ActivityLevel | null>(profile.activity_level);

  const [ageText, setAgeText] = useState(() => {
    const year = col(profile.birth_year);
    return year === null ? "" : String(ageFromBirthYear(year));
  });

  const [cmText, setCmText] = useState(() => {
    const cm = col(profile.height_cm);
    return cm === null ? "" : String(Math.round(cm));
  });
  const [feetText, setFeetText] = useState(() => {
    const cm = col(profile.height_cm);
    return cm === null ? "" : String(cmToFeetInches(cm).feet);
  });
  const [inchText, setInchText] = useState(() => {
    const cm = col(profile.height_cm);
    return cm === null ? "" : String(cmToFeetInches(cm).inches);
  });

  const [weightText, setWeightText] = useState(() => {
    const kg = latestWeightKg(weights) ?? col(profile.plan_basis_weight_kg);
    return kg === null ? "" : trim(weightIn(kg, profile.weight_unit));
  });
  const [goalText, setGoalText] = useState(() => {
    const kg = col(profile.goal_weight_kg);
    return kg === null ? "" : trim(weightIn(kg, profile.weight_unit));
  });

  const [applying, setApplying] = useState(false);

  /* ---- persistence. The inputs are written as they settle, so reopening this
     shows what was entered before even if the recommendation was never
     applied. One debounced write, never one per keystroke. */

  const saveRef = useRef(saveProfile);
  const pending = useRef<Partial<Profile> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    saveRef.current = saveProfile;
  });

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = pending.current;
    pending.current = null;
    if (patch) await saveRef.current(patch);
  }, []);

  const queue = useCallback(
    (patch: Partial<Profile>) => {
      pending.current = { ...(pending.current ?? {}), ...patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Leaving the screen mid-edit must not drop what was just typed.
  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  /* -------------------------------------------------------- derived values */

  const age = inRange(parseNum(ageText), AGE_MIN, AGE_MAX);

  const heightCm = useMemo(() => {
    if (heightUnit === "cm") return inRange(parseNum(cmText), CM_MIN, CM_MAX);
    const feet = inRange(parseNum(feetText), FEET_MIN, FEET_MAX);
    if (feet === null) return null;
    // A blank inches box means none — 6 ft flat is a real height.
    const inches = inRange(parseNum(inchText), 0, 11) ?? 0;
    return feetInchesToCm(feet, inches);
  }, [heightUnit, cmText, feetText, inchText]);

  const weightKg = useMemo(() => {
    const v = parseNum(weightText);
    return v === null ? null : inRange(weightToKg(v, weightUnit), KG_MIN, KG_MAX);
  }, [weightText, weightUnit]);

  const goalKg = useMemo(() => {
    const v = parseNum(goalText);
    return v === null ? null : inRange(weightToKg(v, weightUnit), KG_MIN, KG_MAX);
  }, [goalText, weightUnit]);

  /** Recomputed as the fields change — there is no "calculate" button. */
  const rec = useMemo(() => {
    if (
      sex === null ||
      age === null ||
      heightCm === null ||
      weightKg === null ||
      goalKg === null ||
      activity === null
    ) {
      return null;
    }
    return recommend({ sex, age, heightCm, weightKg, goalWeightKg: goalKg, activity });
  }, [sex, age, heightCm, weightKg, goalKg, activity]);

  const missing = [
    sex === null ? "sex" : null,
    age === null ? "age" : null,
    heightCm === null ? "height" : null,
    weightKg === null ? "current weight" : null,
    goalKg === null ? "goal weight" : null,
    activity === null ? "activity" : null,
  ].filter((s): s is string => s !== null);

  const currentCalories = Math.round(Number(targets.calories_target));
  const replaces =
    rec &&
    Number.isFinite(currentCalories) &&
    currentCalories > 0 &&
    currentCalories !== rec.calories
      ? `Replaces ${fmt(currentCalories)} kcal, from today forward. Past days keep their old target.`
      : null;

  const anyEntered =
    sex !== null ||
    activity !== null ||
    ageText !== "" ||
    cmText !== "" ||
    feetText !== "" ||
    inchText !== "" ||
    weightText !== "" ||
    goalText !== "";

  /* -------------------------------------------------------------- handlers */

  /** Switching units CONVERTS what is on screen. 140 lb becomes 63.5 kg — the
   *  number is never reset, and never silently relabelled. */
  const convertWeightText = useCallback((from: WeightUnit, to: WeightUnit) => {
    const swap = (text: string) => {
      const n = parseNum(text);
      return n === null ? text : trim(weightIn(weightToKg(n, from), to));
    };
    setWeightText(swap);
    setGoalText(swap);
  }, []);

  const pickWeightUnit = useCallback(
    async (next: WeightUnit) => {
      if (next === weightUnit || pendingWeightUnit !== null) return;
      // Land any queued body-field write first: two PATCHes racing on the same
      // row can come back out of order and resurrect the old preference.
      await flush();
      const prev = weightUnit;
      setPendingWeightUnit(next);
      convertWeightText(prev, next);
      const ok = await saveProfile({ weight_unit: next });
      // A failed write leaves the app on the old unit, so the numbers follow it
      // back rather than sitting there mislabelled.
      if (!ok) convertWeightText(next, prev);
      setPendingWeightUnit(null);
    },
    [weightUnit, pendingWeightUnit, flush, convertWeightText, saveProfile],
  );

  const convertHeightText = useCallback((cm: number | null, to: HeightUnit) => {
    if (cm === null) {
      // Clearing the boxes matters: returning early left the old text in the
      // other unit's fields, so a height the user had just deleted reappeared
      // on switching back — and fed the estimate while the stored value was
      // null.
      setCmText("");
      setFeetText("");
      setInchText("");
      return;
    }
    if (to === "cm") {
      setCmText(String(Math.round(cm)));
    } else {
      const { feet, inches } = cmToFeetInches(cm);
      setFeetText(String(feet));
      setInchText(String(inches));
    }
  }, []);

  const pickHeightUnit = useCallback(
    async (next: HeightUnit) => {
      if (next === heightUnit || pendingHeightUnit !== null) return;
      await flush();
      const prev = heightUnit;
      const cm = heightCm;
      setPendingHeightUnit(next);
      convertHeightText(cm, next);
      const ok = await saveProfile({ height_unit: next });
      if (!ok) convertHeightText(cm, prev);
      setPendingHeightUnit(null);
    },
    [heightUnit, pendingHeightUnit, heightCm, flush, convertHeightText, saveProfile],
  );

  const changeAge = (text: string) => {
    setAgeText(text);
    const years = inRange(parseNum(text), AGE_MIN, AGE_MAX);
    // Stored as a birth year, so the age is not stale a year from now.
    queue({
      birth_year: years === null ? null : new Date().getUTCFullYear() - Math.round(years),
    });
  };

  const changeCm = (text: string) => {
    setCmText(text);
    queue({ height_cm: inRange(parseNum(text), CM_MIN, CM_MAX) });
  };

  /** Feet and inches are two boxes and one stored centimetre value, so either
   *  box has to write the pair. */
  const queueFeetInches = (feetSrc: string, inchSrc: string) => {
    const feet = inRange(parseNum(feetSrc), FEET_MIN, FEET_MAX);
    const inches = inRange(parseNum(inchSrc), 0, 11) ?? 0;
    queue({ height_cm: feet === null ? null : round2(feetInchesToCm(feet, inches)) });
  };

  const changeFeet = (text: string) => {
    setFeetText(text);
    queueFeetInches(text, inchText);
  };

  const changeInch = (text: string) => {
    setInchText(text);
    queueFeetInches(feetText, text);
  };

  /** Current weight is normally read from the weight log, but someone setting
   *  up before their first weigh-in has no log to read. Persisting it as the
   *  plan's basis weight keeps the form re-openable for them, and is the same
   *  value applyRecommendation records. */
  const changeWeight = (text: string) => {
    setWeightText(text);
    const v = parseNum(text);
    const kg = v === null ? null : inRange(weightToKg(v, weightUnit), KG_MIN, KG_MAX);
    queue({ plan_basis_weight_kg: kg === null ? null : round2(kg) });
  };

  const changeGoal = (text: string) => {
    setGoalText(text);
    const v = parseNum(text);
    const kg = v === null ? null : inRange(weightToKg(v, weightUnit), KG_MIN, KG_MAX);
    queue({ goal_weight_kg: kg === null ? null : round2(kg) });
  };

  const pickSex = (v: Sex) => {
    setSex(v);
    queue({ sex: v });
  };

  const pickActivity = (v: ActivityLevel) => {
    setActivity(v);
    queue({ activity_level: v });
  };

  const clearAll = async () => {
    setSex(null);
    setActivity(null);
    setAgeText("");
    setCmText("");
    setFeetText("");
    setInchText("");
    setWeightText("");
    setGoalText("");
    // Drop the queued write, or the debounce would put the old values straight
    // back a moment after the clear lands.
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
    await saveProfile({
      sex: null,
      birth_year: null,
      height_cm: null,
      goal_weight_kg: null,
      activity_level: null,
    });
  };

  /** The only thing on this screen that changes a target. */
  const apply = async () => {
    if (!rec || applying) return;
    setApplying(true);
    // One write at a time: the inputs, then the recommendation.
    await flush();
    const ok = await applyRecommendation(rec);
    setApplying(false);
    if (ok) onDone?.();
  };

  /* ------------------------------------------------------------------ view */

  const unitsBusy = pendingWeightUnit !== null || pendingHeightUnit !== null;

  return (
    <div className="flex flex-col gap-2.5">
      <p className="px-0.5 text-[12.5px] leading-[1.5] text-faint text-balance">
        These work out a calorie recommendation and nothing else. They&rsquo;re stored
        only so you can reopen this and change them.
      </p>

      {/* ------------------------------------------------------------ units */}

      <FieldBlock label="Units" hint="Applies everywhere in the app, not just here.">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className={SUB_LABEL}>Weight</span>
            <span className="flex-1">
              <Segmented
                ariaLabel="Weight unit"
                value={weightUnit}
                options={WEIGHT_UNITS}
                disabled={unitsBusy}
                onPick={(v) => void pickWeightUnit(v)}
              />
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className={SUB_LABEL}>Height</span>
            <span className="flex-1">
              <Segmented
                ariaLabel="Height unit"
                value={heightUnit}
                options={HEIGHT_UNITS}
                disabled={unitsBusy}
                onPick={(v) => void pickHeightUnit(v)}
              />
            </span>
          </div>
        </div>
      </FieldBlock>

      {/* -------------------------------------------------------------- sex */}

      <FieldBlock
        label="Sex"
        hint="Used for the metabolic-rate formula. Prefer not to say averages the two."
      >
        <ChipGroup ariaLabel="Sex" value={sex} options={SEX_OPTIONS} onPick={pickSex} />
      </FieldBlock>

      {/* ------------------------------------------------------ age, height */}

      <FieldRow label="Age" htmlFor={`${uid}-age`}>
        <NumberField
          id={`${uid}-age`}
          ariaLabel="Age in years"
          value={ageText}
          suffix="yrs"
          width={72}
          onChange={changeAge}
        />
      </FieldRow>

      <FieldRow
        label="Height"
        htmlFor={heightUnit === "cm" ? `${uid}-cm` : `${uid}-ft`}
      >
        {heightUnit === "cm" ? (
          <NumberField
            id={`${uid}-cm`}
            ariaLabel="Height in centimetres"
            value={cmText}
            suffix="cm"
            width={72}
            onChange={changeCm}
          />
        ) : (
          <>
            <NumberField
              id={`${uid}-ft`}
              ariaLabel="Height, feet"
              value={feetText}
              suffix="ft"
              width={52}
              onChange={changeFeet}
            />
            <NumberField
              id={`${uid}-in`}
              ariaLabel="Height, inches"
              value={inchText}
              suffix="in"
              width={52}
              onChange={changeInch}
            />
          </>
        )}
      </FieldRow>

      {/* ---------------------------------------------------------- weights */}

      <FieldRow
        label="Current weight"
        htmlFor={`${uid}-weight`}
        hint="Just for this estimate — your morning weigh-ins are logged on the Weight screen."
      >
        <NumberField
          id={`${uid}-weight`}
          ariaLabel={`Current weight in ${weightUnit}`}
          value={weightText}
          suffix={weightUnit}
          width={84}
          onChange={changeWeight}
        />
      </FieldRow>

      <FieldRow label="Goal weight" htmlFor={`${uid}-goal`}>
        <NumberField
          id={`${uid}-goal`}
          ariaLabel={`Goal weight in ${weightUnit}`}
          value={goalText}
          suffix={weightUnit}
          width={84}
          onChange={changeGoal}
        />
      </FieldRow>

      {/* --------------------------------------------------------- activity */}

      <FieldBlock label="Activity" hint="Pick the closest one — it scales the estimate.">
        <div className="flex flex-col gap-2">
          {ACTIVITY_ORDER.map((key) => {
            const option = ACTIVITY[key];
            const on = activity === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                onClick={() => pickActivity(key)}
                className={`rounded-[14px] border px-3.5 py-2.5 text-left transition-colors ${
                  on ? "border-accent-wash-line bg-accent-wash" : "border-line bg-sunken"
                }`}
              >
                <span className="block text-[13px] font-bold">{option.label}</span>
                <span className="mt-px block text-[11.5px] text-faint">{option.hint}</span>
              </button>
            );
          })}
        </div>
      </FieldBlock>

      {/* ----------------------------------------------------------- result */}

      {rec ? (
        <div className="mt-1 rounded-[24px] border border-[oklch(0.91_0.012_80)] bg-sunken p-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[oklch(0.6_0.03_65)]">
            A starting point
          </div>

          <div className="mt-2 flex items-baseline gap-2">
            <span className="tnum font-mono text-[40px] font-bold leading-[0.95] tracking-[-0.035em]">
              {fmt(rec.calories)}
            </span>
            <span className="text-[15px] text-muted">kcal a day</span>
          </div>

          <div className="tnum mt-1.5 font-mono text-[11px] text-faint">
            resting {fmt(rec.bmr)} · daily burn {fmt(rec.tdee)}
          </div>

          <div className="mt-3.5 grid grid-cols-3 gap-2">
            <StatCard label="Protein" value={g(rec.protein_g)} valueSize={16} />
            <StatCard label="Carbs" value={g(rec.carbs_g)} valueSize={16} />
            <StatCard label="Fat" value={g(rec.fat_g)} valueSize={16} />
          </div>

          {rec.weeksToGoal !== null && (
            <p className="mt-3 text-[13px] leading-[1.45] text-muted">
              About{" "}
              <span className="tnum font-mono font-bold text-ink">{rec.weeksToGoal}</span>{" "}
              {rec.weeksToGoal === 1 ? "week" : "weeks"} at this pace — around{" "}
              <span className="tnum font-mono">
                {formatWeightDelta(rec.paceKgPerWeek, weightUnit)}
              </span>{" "}
              a week.
            </p>
          )}

          {rec.notes.length > 0 && (
            <div className="mt-3 flex flex-col gap-2 rounded-[16px] border border-accent-wash-line bg-accent-wash p-3.5">
              {rec.notes.map((note) => (
                <p key={note} className="text-[12.5px] leading-[1.5] text-ink-soft">
                  {note}
                </p>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => void apply()}
            disabled={applying}
            className="mt-4 w-full rounded-[18px] bg-accent py-[15px] text-[15px] font-bold text-surface transition-colors active:bg-accent-hover disabled:bg-disabled"
          >
            {applying ? "Setting your targets…" : "Use these targets"}
          </button>

          {replaces && (
            <p className="mt-2 px-1 text-center text-[11.5px] leading-[1.45] text-faint">
              {replaces}
            </p>
          )}

          <p className="mt-2 px-1 text-center text-[11.5px] leading-[1.45] text-faint text-balance">
            A starting point, not medical advice. Nothing changes until you tap the
            button.
          </p>
        </div>
      ) : (
        <div className="mt-1 rounded-[18px] border border-dashed border-line-dashed px-4 py-3.5">
          <p className="text-[12.5px] leading-[1.5] text-muted text-balance">
            Still needed: {joinList(missing)}. The starting point appears here once
            those are in.
          </p>
          <p className={HINT}>
            None of it is required — you can set the four targets by hand instead.
          </p>
        </div>
      )}

      {anyEntered && (
        <button
          type="button"
          onClick={() => void clearAll()}
          className="mx-auto mt-1 block px-4 py-2 text-[13px] font-semibold text-faint"
        >
          Clear these
        </button>
      )}
    </div>
  );
}

export default SetupCalculator;
