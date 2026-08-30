"use client";

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/components/store";
import { ScreenTitle, StatCard, StepperRow } from "@/components/ui";
import { IconCheck, IconChevronLeft, IconMinus, IconPlus } from "@/components/icons";
import { weightSummary } from "@/lib/calc";
import { fmt, g, lb, signed } from "@/lib/format";
import type { Targets, WeightEntry } from "@/lib/types";

/* ------------------------------------------------------------------ shared */

const STEP_LB = 0.2;

/** The suggested numbers the Skip path commits verbatim (README §11). */
const SUGGESTED: Targets = {
  calories_target: 2850,
  protein_target_g: 200,
  carbs_target_g: 300,
  fat_target_g: 80,
};

/** Weight columns are numeric() and can arrive from PostgREST as strings. */
function seedWeight(weights: WeightEntry[], today: string): number {
  const sorted = [...weights].sort((a, b) => a.local_date.localeCompare(b.local_date));
  const mine = sorted.find((w) => w.local_date === today);
  const latest = sorted[sorted.length - 1];
  const n = Number(mine?.weight ?? latest?.weight ?? 140);
  return Number.isFinite(n) ? n : 140;
}

/* ------------------------------------------------------------------ weight */

export function WeightScreen() {
  const { weights, today, saveWeight, setScreen } = useApp();

  const [value, setValue] = useState<number>(() => seedWeight(weights, today));
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  /** One place where the draft moves, so "Saved ✓" always falls away with it. */
  const apply = (next: number) => {
    const rounded = Math.max(0, Math.round(next * 10) / 10);
    if (rounded === value) return;
    setValue(rounded);
    setSaved(false);
  };

  const commit = () => {
    setEditing(false);
    const n = Number.parseFloat(text.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n)) apply(n);
  };

  const handleSave = () => {
    // Only claim "Saved" once the write came back — otherwise the button would
    // read "Saved ✓" next to the error banner.
    void saveWeight(value).then((ok) => setSaved(ok));
  };

  const summary = weightSummary(weights, today);
  const show = (n: number | null) => (n === null ? "—" : `${lb(n)} lb`);
  const showDelta = (n: number | null) => (n === null ? "—" : `${signed(n)} lb`);

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
                aria-label="Weight in pounds"
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
                  setText(lb(value));
                  setEditing(true);
                }}
                className="tnum font-mono text-[38px] font-bold tracking-[-0.03em]"
              >
                {lb(value)}
              </button>
            )}
            <span className="font-mono text-[14px] text-muted">lb</span>
          </div>
        </div>

        <div className="flex flex-none gap-2">
          <button
            type="button"
            aria-label="Decrease weight by 0.2 pounds"
            onClick={() => apply(value - STEP_LB)}
            className="flex h-12 w-12 items-center justify-center rounded-[16px] border border-line-strong bg-raised-soft text-ink transition-colors active:bg-line"
          >
            <IconMinus size={20} />
          </button>
          <button
            type="button"
            aria-label="Increase weight by 0.2 pounds"
            onClick={() => apply(value + STEP_LB)}
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

export function Onboarding() {
  const { targets, weights, today, saveTargets, setOnboard } = useApp();

  // Nothing here persists until the user commits, so the targets live locally.
  const [draft, setDraft] = useState<Targets>(() => ({
    calories_target: Number(targets.calories_target),
    protein_target_g: Number(targets.protein_target_g),
    carbs_target_g: Number(targets.carbs_target_g),
    fat_target_g: Number(targets.fat_target_g),
  }));

  // Timezone comes from the browser and is exposed in Settings — never asked here.
  const current = weightSummary(weights, today).current;

  const finish = (t: Targets) => {
    void saveTargets(t);
    setOnboard(false);
  };

  const patch = (p: Partial<Targets>) => setDraft((cur) => ({ ...cur, ...p }));

  return (
    <div className="absolute inset-0 z-[6] overflow-y-auto bg-surface px-[22px] pt-[26px] pb-10">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[oklch(0.6_0.03_65)]">
        Setup · once
      </div>

      <h1 className="mt-2.5 text-[27px] font-extrabold leading-[1.15] tracking-[-0.025em] text-balance">
        {"Let's set the numbers you're filling up to."}
      </h1>

      <p className="mt-2.5 text-[14px] leading-[1.5] text-muted-alt">
        {current === null
          ? "You're lean bulking. These stay put until you change them — no morning setup, ever."
          : `You're lean bulking at ${lb(current)} lb. These stay put until you change them — no morning setup, ever.`}
      </p>

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

      <button
        type="button"
        onClick={() => finish(SUGGESTED)}
        className="mt-2 w-full py-3 text-[13px] font-semibold text-faint"
      >
        Skip — use suggested
      </button>
    </div>
  );
}

export default WeightScreen;
