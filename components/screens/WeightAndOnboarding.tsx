"use client";

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/components/store";
import { SetupCalculator } from "@/components/SetupCalculator";
import { ScreenTitle, StatCard, StepperRow } from "@/components/ui";
import { IconCheck, IconChevronLeft, IconMinus, IconPlus } from "@/components/icons";
import { round1, weightSummary } from "@/lib/calc";
import { fmt, g, signed } from "@/lib/format";
import { weightIn, weightStep, weightToKg } from "@/lib/units";
import type { Targets, WeightEntry } from "@/lib/types";

/* ------------------------------------------------------------------ shared */

/** The suggested numbers the Skip path commits verbatim (README §11). */
const SUGGESTED: Targets = {
  calories_target: 2850,
  protein_target_g: 200,
  carbs_target_g: 300,
  fat_target_g: 80,
};

/** 140 lb, as kilograms — the opening guess when there is nothing on record.
 *  Held in kg like the rest of the draft, so it reads as 140.0 lb or 63.5 kg
 *  depending only on the preference. */
const DEFAULT_KG = weightToKg(140, "lb");

/** Seeds the draft from the most recent row, in canonical kilograms. Each row
 *  carries the unit it was logged under, so the number is converted, never
 *  reused as-is. Weight columns are numeric() and can arrive from PostgREST as
 *  strings. */
function seedKg(weights: WeightEntry[], today: string): number {
  const sorted = [...weights].sort((a, b) => a.local_date.localeCompare(b.local_date));
  const row = sorted.find((w) => w.local_date === today) ?? sorted[sorted.length - 1];
  if (!row) return DEFAULT_KG;
  const kg = weightToKg(Number(row.weight), row.unit);
  return Number.isFinite(kg) ? kg : DEFAULT_KG;
}

/* ------------------------------------------------------------------ weight */

export function WeightScreen() {
  const { weights, today, profile, saveWeight, setScreen } = useApp();

  const unit = profile.weight_unit;
  const step = weightStep(unit);
  const unitWord = unit === "kg" ? "kilograms" : "pounds";

  // The draft lives in kilograms and is rendered through the preference, so
  // switching units re-reads the same weight instead of reinterpreting the
  // digits on screen as a different number.
  const [kg, setKg] = useState<number>(() => seedKg(weights, today));
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  /** What the draft reads as in the unit on screen — one decimal, the
   *  resolution of a bathroom scale. Every edit below is expressed in it. */
  const shown = round1(weightIn(kg, unit));

  /** One place where the draft moves, so "Saved ✓" always falls away with it. */
  const apply = (next: number) => {
    const rounded = Math.max(0, round1(next));
    if (rounded === shown) return;
    setKg(weightToKg(rounded, unit));
    setSaved(false);
  };

  const commit = () => {
    setEditing(false);
    const n = Number.parseFloat(text.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n)) apply(n);
  };

  const handleSave = () => {
    // saveWeight stamps the row with profile.weight_unit (see the store), so it
    // has to be handed the number IN that unit. Passing kilograms would file
    // 63.5 under a "lb" label — the 2.2x fabrication this screen exists to
    // avoid — so the conversion happens on the way OUT of the row, not here.
    // Only claim "Saved" once the write came back — otherwise the button would
    // read "Saved ✓" next to the error banner.
    void saveWeight(shown).then((ok) => setSaved(ok));
  };

  const summary = weightSummary(weights, today, unit);
  const show = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)} ${unit}`);
  const showDelta = (n: number | null) => (n === null ? "—" : `${signed(n)} ${unit}`);

  const note =
    weights.length === 0
      ? "Nothing on record yet. Save this morning's number and the averages start filling themselves in."
      : summary.weeklyChange === null
        ? "The weekly change shows up once there are a few mornings to average. Nothing to read into before then."
        : null;

  return (
    <div className="px-5 pt-2 pb-[120px]">
      <button
        type="button"
        onClick={() => setScreen("today")}
        className="mb-2.5 flex items-center gap-1 bg-none text-[13px] font-semibold text-faint-alt"
      >
        <IconChevronLeft size={14} />
        Today
      </button>

      <ScreenTitle
        title="Weight"
        sub="One number a morning. We watch the average, not the day."
      />

      {/* log card */}
      <div className="mt-[18px] flex items-center justify-between gap-4 rounded-[26px] border border-[oklch(0.91_0.012_80)] bg-sunken px-5 py-[22px]">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[oklch(0.56_0.03_65)]">
            Log today
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            {editing ? (
              <input
                ref={inputRef}
                inputMode="decimal"
                value={text}
                maxLength={6}
                aria-label={`Weight in ${unitWord}`}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setText(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") setEditing(false);
                }}
                className="tnum w-[126px] rounded-[10px] bg-line/40 px-1 font-mono text-[38px] font-bold tracking-[-0.03em] outline-none"
              />
            ) : (
              <button
                type="button"
                aria-label="Edit today's weight"
                onClick={() => {
                  setText(shown.toFixed(1));
                  setEditing(true);
                }}
                className="tnum font-mono text-[38px] font-bold tracking-[-0.03em]"
              >
                {shown.toFixed(1)}
              </button>
            )}
            <span className="font-mono text-[14px] text-muted">{unit}</span>
          </div>
        </div>

        <div className="flex flex-none gap-2">
          <button
            type="button"
            aria-label={`Decrease weight by ${step} ${unitWord}`}
            onClick={() => apply(shown - step)}
            className="flex h-12 w-12 items-center justify-center rounded-[16px] border border-line-strong bg-raised-soft text-ink transition-colors active:bg-line"
          >
            <IconMinus size={20} />
          </button>
          <button
            type="button"
            aria-label={`Increase weight by ${step} ${unitWord}`}
            onClick={() => apply(shown + step)}
            className="flex h-12 w-12 items-center justify-center rounded-[16px] border border-line-strong bg-raised-soft text-ink transition-colors active:bg-line"
          >
            <IconPlus size={20} />
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSave}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[18px] bg-accent py-[15px] text-[15px] font-bold text-surface transition-colors active:bg-accent-hover"
      >
        {saved ? (
          <>
            Saved
            <IconCheck size={15} />
          </>
        ) : (
          "Save today's weight"
        )}
      </button>

      <div className="mt-[18px] grid grid-cols-2 gap-2.5">
        <StatCard label="Current" value={show(summary.current)} valueSize={19} />
        <StatCard label="7-day avg" value={show(summary.avg7)} valueSize={19} />
        <StatCard label="30-day avg" value={show(summary.avg30)} valueSize={19} />
        <StatCard
          label="Weekly change"
          value={showDelta(summary.weeklyChange)}
          valueSize={19}
        />
      </div>

      {note && (
        <p className="mt-3 px-0.5 text-[12.5px] leading-[1.45] text-faint text-balance">
          {note}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- onboarding */

type OnboardStep = "choose" | "calculator" | "numbers";

export function Onboarding() {
  const { targets, weights, today, profile, saveTargets, setOnboard } = useApp();
  const [step, setStep] = useState<OnboardStep>("choose");

  // Nothing here persists until the user commits, so the targets live locally.
  const [draft, setDraft] = useState<Targets>(() => ({
    calories_target: Number(targets.calories_target),
    protein_target_g: Number(targets.protein_target_g),
    carbs_target_g: Number(targets.carbs_target_g),
    fat_target_g: Number(targets.fat_target_g),
  }));

  // Timezone comes from the browser and is exposed in Settings — never asked here.
  const current = weightSummary(weights, today, profile.weight_unit).current;

  const finish = (t: Targets) => {
    void saveTargets(t);
    setOnboard(false);
  };

  const patch = (p: Partial<Targets>) => setDraft((cur) => ({ ...cur, ...p }));

  const shell = (children: React.ReactNode) => (
    <div className="absolute inset-0 z-[6] overflow-y-auto bg-surface px-[22px] pt-[26px] pb-10">
      {children}
    </div>
  );

  const back = (
    <button
      type="button"
      onClick={() => setStep("choose")}
      className="mb-2.5 flex items-center gap-1 text-[13px] font-semibold text-faint-alt"
    >
      <IconChevronLeft size={14} />
      Back
    </button>
  );

  /* ------------------------------------------------------------- choose
     The first screen asks one question instead of presenting four steppers
     to someone who has no idea what to put in them. Neither branch is a
     gate: "Skip" sets sensible defaults and gets straight to the camera. */

  if (step === "choose") {
    return shell(
      <>
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[oklch(0.6_0.03_65)]">
          Setup · once
        </div>

        <h1 className="mt-2.5 text-[27px] font-extrabold leading-[1.15] tracking-[-0.025em] text-balance">
          {"Let's set the numbers you're filling up to."}
        </h1>

        <p className="mt-2.5 text-[14px] leading-[1.5] text-muted-alt">
          {current === null
            ? "One number matters: the calories you're aiming to hit each day. Set it however you like — it stays put until you change it."
            : `You're at ${current.toFixed(1)} ${profile.weight_unit}. One number matters: the calories you're aiming to hit each day, and it stays put until you change it.`}
        </p>

        <div className="mt-6 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => setStep("calculator")}
            className="rounded-[20px] border border-[oklch(0.91_0.012_80)] bg-sunken p-4 text-left transition-colors active:bg-[oklch(0.96_0.02_70)]"
          >
            <div className="text-[15px] font-bold">Help me work it out</div>
            <div className="mt-1 text-[12.5px] leading-[1.45] text-muted text-balance">
              A few questions — height, weight, where you want to get to — and
              you get a starting point you can edit.
            </div>
          </button>

          <button
            type="button"
            onClick={() => setStep("numbers")}
            className="rounded-[20px] border border-[oklch(0.91_0.012_80)] bg-sunken p-4 text-left transition-colors active:bg-[oklch(0.96_0.02_70)]"
          >
            <div className="text-[15px] font-bold">I know my numbers</div>
            <div className="mt-1 text-[12.5px] leading-[1.45] text-muted text-balance">
              Type your calorie and macro targets straight in.
            </div>
          </button>
        </div>

        <button
          type="button"
          onClick={() => finish(SUGGESTED)}
          className="mt-4 w-full py-3 text-[13px] font-semibold text-faint"
        >
          Skip — use suggested
        </button>
      </>,
    );
  }

  /* --------------------------------------------------------- calculator */

  if (step === "calculator") {
    return shell(
      <>
        {back}
        <h1 className="text-[24px] font-extrabold leading-[1.15] tracking-[-0.025em] text-balance">
          Let&rsquo;s work out a starting point.
        </h1>
        <div className="mt-4">
          <SetupCalculator onDone={() => setOnboard(false)} />
        </div>
        <button
          type="button"
          onClick={() => finish(SUGGESTED)}
          className="mt-4 w-full py-3 text-[13px] font-semibold text-faint"
        >
          Skip — use suggested
        </button>
      </>,
    );
  }

  /* ------------------------------------------------------------ numbers */

  return shell(
    <>
      {back}
      <h1 className="text-[24px] font-extrabold leading-[1.15] tracking-[-0.025em] text-balance">
        Your daily targets.
      </h1>

      <div className="mt-[22px] flex flex-col gap-2.5">
        <StepperRow
          variant="onboard"
          label="Calories"
          value={draft.calories_target}
          step={50}
          format={fmt}
          onChange={(n) => patch({ calories_target: n })}
        />
        <StepperRow
          variant="onboard"
          label="Protein"
          value={draft.protein_target_g}
          step={5}
          format={g}
          onChange={(n) => patch({ protein_target_g: n })}
        />
        <StepperRow
          variant="onboard"
          label="Carbohydrates"
          value={draft.carbs_target_g}
          step={10}
          format={g}
          onChange={(n) => patch({ carbs_target_g: n })}
        />
        <StepperRow
          variant="onboard"
          label="Fat"
          value={draft.fat_target_g}
          step={5}
          format={g}
          onChange={(n) => patch({ fat_target_g: n })}
        />
      </div>

      <div className="mt-4 rounded-[20px] border border-accent-wash-line bg-accent-wash p-4 text-[13px] leading-[1.5] text-balance">
        {`A day counts as a win the moment calories hit ${fmt(draft.calories_target)}. Going over is still a win — macros are information, not a verdict.`}
      </div>

      <button
        type="button"
        onClick={() => finish(draft)}
        className="mt-5 w-full rounded-[20px] bg-accent py-4 text-[15px] font-bold text-surface transition-colors active:bg-accent-hover"
      >
        Start tracking
      </button>
    </>,
  );
}

export default WeightScreen;
