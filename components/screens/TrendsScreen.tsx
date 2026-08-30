"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/store";
import { ScreenTitle, StatCard } from "@/components/ui";
import {
  calorieBars,
  correlation,
  rollingWeight,
  targetLinePct,
  weightChangeLabel,
  weightPolylines,
  windowStats,
} from "@/lib/calc";
import { fmt, signed, trim } from "@/lib/format";

type WindowDays = 7 | 30;
const WINDOWS: WindowDays[] = [7, 30];

/** Trends (README §8). Every number here comes out of lib/calc — the screen
 *  only picks the window and lays the results out. */
export default function TrendsScreen() {
  const { dailyLogs, weights, today, targets } = useApp();
  const [days, setDays] = useState<WindowDays>(7);

  // PostgREST hands numeric() columns back as strings; coerce before math.
  const calTarget = Number(targets.calories_target);
  const proteinTarget = Number(targets.protein_target_g);

  const stats = useMemo(
    () => windowStats(dailyLogs, weights, today, days),
    [dailyLogs, weights, today, days],
  );
  const bars = useMemo(
    () => calorieBars(dailyLogs, today, days, calTarget),
    [dailyLogs, today, days, calTarget],
  );
  const linePct = useMemo(() => targetLinePct(bars, calTarget), [bars, calTarget]);
  const points = useMemo(() => rollingWeight(weights, 7), [weights]);
  const lines = useMemo(() => weightPolylines(points), [points]);
  const corr = useMemo(
    () => correlation(dailyLogs, weights, today),
    [dailyLogs, weights, today],
  );

  const hasLoggedDays = stats.daysLogged > 0;
  const hasBars = bars.some((b) => b.calories > 0);
  const hasWeightLine = points.length >= 2 && lines.avg.length > 0;
  const changeLabel = hasWeightLine ? weightChangeLabel(points) : null;
  const adherence = Math.round(stats.adherencePct);

  const gap = days === 7 ? "gap-2" : "gap-[3px]";
  // 30 initials in 352px is mush — label every 5th bar, anchored on today.
  const showDay = (i: number) => days === 7 || (bars.length - 1 - i) % 5 === 0;

  return (
    <div className="px-5 pt-2 pb-[120px]">
      <ScreenTitle title="Trends" />

      {/* ------------------------------------------------ window switch */}
      <div className="mt-3.5 flex rounded-full bg-[oklch(0.955_0.012_80)] p-[3px]">
        {WINDOWS.map((d) => {
          const active = days === d;
          return (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              aria-pressed={active}
              className={`flex-1 rounded-full py-[9px] text-[13px] font-bold transition-colors ${
                active
                  ? "bg-raised-soft text-ink shadow-seg"
                  : "text-[oklch(0.55_0.02_65)]"
              }`}
            >
              {d} days
            </button>
          );
        })}
      </div>

      {/* ---------------------------------------------------- stat grid */}
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <StatCard
          label="Avg calories"
          value={hasLoggedDays ? fmt(stats.avgCalories) : "—"}
          sub={`vs ${fmt(calTarget)} target`}
        />
        <StatCard
          label="Days at target"
          value={`${stats.daysAtTarget} / ${days}`}
          sub={`${adherence}% adherence`}
        />
        <StatCard
          label="Avg protein"
          value={hasLoggedDays ? `${trim(stats.avgProtein)} g` : "—"}
          sub={`target ${trim(proteinTarget)} g`}
        />
        <StatCard
          label="Weight change"
          value={
            stats.weightChange === null ? "—" : `${signed(stats.weightChange)} lb`
          }
          sub={
            stats.weightChange === null
              ? "log a few weights"
              : days === 7
                ? "7-day average"
                : "30-day trend"
          }
        />
      </div>

      {/* --------------------------------------------- calories vs target */}
      <div className="mt-3 rounded-[24px] border border-line bg-raised px-4 py-[18px]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[14px] font-bold">Calories vs target</span>
          <span className="tnum flex-none font-mono text-[10px] text-faint-alt">
            {fmt(calTarget)} kcal line
          </span>
        </div>

        {hasBars ? (
          <div className="mt-4">
            <div
              className={`relative flex h-[130px] items-end ${gap}`}
              role="img"
              aria-label={`Daily calories for the last ${days} days against a ${fmt(
                calTarget,
              )} kcal target. ${stats.daysAtTarget} of ${days} days at or above target.`}
            >
              {bars.map((b) => (
                <div key={b.date} className="flex h-full flex-1 items-end">
                  <div
                    className={`w-full rounded-[7px_7px_3px_3px] transition-[height] duration-500 ${
                      b.atTarget ? "bg-good" : "bg-below"
                    }`}
                    style={{ height: `${b.heightPct}%` }}
                  />
                </div>
              ))}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 border-t-[1.5px] border-dashed border-[oklch(0.75_0.03_70)]"
                style={{ bottom: `${linePct}%` }}
              />
            </div>

            <div className={`mt-1.5 flex ${gap}`} aria-hidden="true">
              {bars.map((b, i) => (
                <div
                  key={b.date}
                  className="tnum flex-1 text-center font-mono text-[9px] text-faint-alt"
                >
                  {showDay(i) ? b.day : ""}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-3 text-[13px] leading-[1.5] text-muted text-balance">
            Log a few days and this fills in.
          </p>
        )}
      </div>

      {/* ---------------------------------------------------- weight card */}
      <div className="mt-3 rounded-[24px] border border-line bg-raised px-4 py-[18px]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[14px] font-bold">Weight &amp; 7-day average</span>
          {changeLabel && (
            <span className="tnum flex-none font-mono text-[10px] text-accent">
              {changeLabel}
            </span>
          )}
        </div>

        {hasWeightLine ? (
          <>
            <svg
              viewBox="0 0 300 110"
              className="mt-3.5 h-[110px] w-full overflow-visible"
              role="img"
              aria-label={`Daily weight with its 7-day moving average${
                changeLabel ? `, ${changeLabel}` : ""
              }.`}
            >
              <polyline
                points={lines.raw}
                fill="none"
                stroke="oklch(0.82 0.03 70)"
                strokeWidth={2}
              />
              <polyline
                points={lines.avg}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="mt-2.5 flex items-center gap-3.5 font-mono text-[10px]">
              <span className="text-muted">— daily</span>
              <span className="text-accent">— 7-day avg</span>
            </div>
          </>
        ) : (
          <p className="mt-3 text-[13px] leading-[1.5] text-muted text-balance">
            Log a couple of mornings and the line starts here.
          </p>
        )}
      </div>

      {/* ----------------------------------------------- correlation card */}
      <div className="mt-3 rounded-[24px] border border-accent-wash-line bg-accent-wash p-[18px]">
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-accent-quiet">
          {corr.headline}
        </div>
        <p className="mt-2 text-[13.5px] leading-[1.5] text-body text-balance">
          {corr.body}
        </p>
      </div>

      {/* ------------------------------------------------ target adherence */}
      <div className="mt-3 rounded-[24px] border border-line bg-raised px-4 py-[18px]">
        <div className="text-[14px] font-bold">Target adherence</div>
        <div className="mt-3.5 flex h-3 overflow-hidden rounded-[7px]">
          <div
            className="bg-good transition-[width] duration-500"
            style={{ width: `${adherence}%` }}
          />
          <div className="flex-1 bg-track-soft" />
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-3 font-mono text-[11px] text-[oklch(0.5_0.02_65)]">
          <span className="tnum">
            {stats.daysAtTarget} of {days} days at or above target
          </span>
          <span className="tnum flex-none">{adherence}%</span>
        </div>
      </div>
    </div>
  );
}
