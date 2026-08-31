"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/store";
import { ScreenTitle } from "@/components/ui";
import { IconChevronLeft, IconChevronRight, IconSearch } from "@/components/icons";
import { fmt, trim } from "@/lib/format";
import { formatWeight, weightToKg } from "@/lib/units";
import {
  daysBetween,
  daysInMonth,
  iso,
  longDate,
  monthName,
  weekday,
} from "@/lib/dates";
import type { DailyLog, FoodEntry } from "@/lib/types";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** Calendar-month ordinal, so paging is integer math instead of date math. */
function monthIndex(isoDate: string): number {
  const [y, m] = isoDate.split("-").map(Number);
  return y * 12 + (m - 1);
}

export default function HistoryScreen() {
  const {
    today,
    floor,
    dailyLogs,
    weights,
    profile,
    entriesForDate,
    searchFoods,
    reAdd,
    openEdit,
  } = useApp();

  /* ---------------------------------------------------------- month pager */

  const currentIdx = monthIndex(today);
  // Three months are reachable — this one and the two before it — and never
  // further back than the month the 90-day retention floor lands in.
  const oldestIdx = Math.max(currentIdx - 2, monthIndex(floor));
  const maxBack = currentIdx - oldestIdx;

  const [back, setBack] = useState(0);
  const shownIdx = currentIdx - back;
  const shownYear = Math.floor(shownIdx / 12);
  const shownMonth = shownIdx % 12;
  const atOldest = back >= maxBack;
  const atNewest = back <= 0;
  const shownLabel = monthName(shownYear, shownMonth);

  const logsByDate = useMemo(
    () => new Map<string, DailyLog>(dailyLogs.map((l) => [l.local_date, l])),
    [dailyLogs],
  );

  const grid = useMemo(() => {
    const count = daysInMonth(shownYear, shownMonth);
    const pad = weekday(iso(shownYear, shownMonth, 1));
    const days: {
      date: string;
      day: number;
      log: DailyLog | undefined;
      future: boolean;
    }[] = [];
    for (let n = 1; n <= count; n++) {
      const date = iso(shownYear, shownMonth, n);
      days.push({
        date,
        day: n,
        log: logsByDate.get(date),
        // daysBetween(date, today) is today − date, so a negative gap is ahead.
        future: daysBetween(date, today) < 0,
      });
    }
    return { pad, days };
  }, [shownYear, shownMonth, logsByDate, today]);

  /* ----------------------------------------------------------- day detail */

  const [picked, setPicked] = useState(today);

  // Each day is scored against the target that was active on that date, which
  // the daily_logs row already carries — never the target in force today.
  const dayLog = logsByDate.get(picked) ?? null;
  const hasLog = dayLog !== null && Number(dayLog.entry_count) > 0;
  const dayTotal = dayLog ? Number(dayLog.total_calories) : 0;
  const dayTarget =
    dayLog && dayLog.calories_target != null ? Number(dayLog.calories_target) : 0;
  const achieved = dayLog?.calorie_goal_achieved === true;
  const macroText = dayLog
    ? `${trim(Number(dayLog.total_protein_g))} P · ${trim(
        Number(dayLog.total_carbs_g),
      )} C · ${trim(Number(dayLog.total_fat_g))} F`
    : null;

  const weightRow = useMemo(
    () => weights.find((w) => w.local_date === picked),
    [weights, picked],
  );
  const dayWeight = weightRow
    ? Number(weightRow.weight)
    : dayLog && dayLog.weight != null
      ? Number(dayLog.weight)
      : null;
  // The unit the row was STORED in — used to interpret the number, never to
  // label it. The label comes from the preference below.
  const storedUnit = weightRow?.unit ?? dayLog?.weight_unit ?? profile.weight_unit;

  const [dayEntries, setDayEntries] = useState<FoodEntry[] | null>(null);
  const loadedFor = useRef<string | null>(null);

  // Keyed on the date *and* the day's totals, so editing a historical entry
  // (which refreshes daily_logs) re-reads the rows below in place.
  const reloadKey = `${picked}|${dayLog ? `${dayLog.entry_count}:${dayLog.total_calories}` : "-"}`;

  useEffect(() => {
    const date = reloadKey.slice(0, reloadKey.indexOf("|"));
    let alive = true;
    // Only blank the list when the day itself changes — a totals refresh swaps
    // the rows in place rather than flashing empty.
    if (loadedFor.current !== date) {
      loadedFor.current = date;
      setDayEntries(null);
    }
    void entriesForDate(date).then((rows) => {
      if (alive) setDayEntries(rows);
    });
    return () => {
      alive = false;
    };
  }, [reloadKey, entriesForDate]);

  /* ---------------------------------------------------------------- search */

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoodEntry[]>([]);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const term = query.trim();
    let alive = true;
    const timer = setTimeout(() => {
      if (term.length < 2) {
        if (alive) {
          setResults([]);
          setSearched(false);
        }
        return;
      }
      void searchFoods(term).then((rows) => {
        if (!alive) return;
        setResults(rows);
        setSearched(true);
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, searchFoods]);

  /* ------------------------------------------------------------------ view */

  return (
    <div className="px-5 pt-2 pb-[120px]">
      <ScreenTitle
        title="History"
        sub="Last 90 days · filled days are at or above target"
      />

      <div className="mt-3.5 mb-3.5 flex items-center justify-between gap-2.5">
        <button
          type="button"
          onClick={() => setBack((b) => Math.min(maxBack, b + 1))}
          disabled={atOldest}
          aria-label="Previous month"
          className={`flex h-9 w-9 flex-none items-center justify-center rounded-[12px] border border-line-chip bg-raised transition-colors ${
            atOldest ? "text-disabled" : "text-ink active:bg-sunken"
          }`}
        >
          <IconChevronLeft size={17} />
        </button>

        <span aria-live="polite" className="text-center text-[14px] font-bold">
          {shownLabel}
        </span>

        <button
          type="button"
          onClick={() => setBack((b) => Math.max(0, b - 1))}
          disabled={atNewest}
          aria-label="Next month"
          className={`flex h-9 w-9 flex-none items-center justify-center rounded-[12px] border border-line-chip bg-raised transition-colors ${
            atNewest ? "text-disabled" : "text-ink active:bg-sunken"
          }`}
        >
          <IconChevronRight size={17} />
        </button>
      </div>

      <div className="mb-2 grid grid-cols-7 gap-[6px]" aria-hidden="true">
        {WEEKDAYS.map((d, i) => (
          <div key={i} className="text-center font-mono text-[9px] text-faint">
            {d}
          </div>
        ))}
      </div>

      <div role="group" aria-label={`${shownLabel} calendar`} className="grid grid-cols-7 gap-[6px]">
        {Array.from({ length: grid.pad }, (_, i) => (
          <div key={`pad-${i}`} aria-hidden="true" className="aspect-square" />
        ))}

        {grid.days.map(({ date, day, log, future }) => {
          const logged = !future && !!log && Number(log.entry_count) > 0;
          const above = logged && log?.calorie_goal_achieved === true;
          const selected = date === picked;

          const fill = above
            ? "bg-good-wash text-ink"
            : logged
              ? "bg-[oklch(0.955_0.012_80)] text-ink"
              : "bg-transparent text-disabled";

          return (
            <button
              key={date}
              type="button"
              disabled={!logged}
              aria-pressed={selected}
              aria-label={
                logged
                  ? `${longDate(date)} — ${fmt(Number(log?.total_calories ?? 0))} kcal, ${
                      above ? "target reached" : "below target"
                    }`
                  : `${longDate(date)} — nothing logged`
              }
              onClick={() => setPicked(date)}
              className={`tnum flex aspect-square items-center justify-center rounded-[12px] border font-mono text-[11px] font-medium transition-colors ${fill} ${
                selected ? "border-accent" : "border-line-soft"
              }`}
            >
              {day}
            </button>
          );
        })}
      </div>

      <p className="mt-3 font-mono text-[10.5px] leading-[1.5] text-pretty text-[oklch(0.6_0.03_65)]">
        {atOldest
          ? `Oldest day kept: ${longDate(floor)}. Anything before that has rolled off the 90-day window.`
          : `Logs are kept for 90 days (back to ${longDate(floor)}), then removed automatically.`}
      </p>

      <section className="mt-5 rounded-[24px] border border-line bg-sunken-alt p-[18px]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold">{longDate(picked)}</h2>
            <p className="mt-0.5 text-[12px] text-muted">
              {hasLog
                ? dayTarget > 0
                  ? `target ${fmt(dayTarget)} kcal · ${achieved ? "target reached" : "below target"}`
                  : achieved
                    ? "target reached"
                    : "below target"
                : "Nothing logged on this day yet."}
            </p>
          </div>
          {hasLog && (
            <div
              className={`tnum flex-none font-mono text-[22px] font-bold ${
                achieved ? "text-good" : "text-ink"
              }`}
            >
              {fmt(dayTotal)}
            </div>
          )}
        </div>

        {(hasLog || dayWeight !== null) && (
          <div className="mt-3.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-[11px] text-[oklch(0.48_0.02_65)]">
            {hasLog && macroText && <span className="tnum">{macroText}</span>}
            {hasLog && macroText && dayWeight !== null && (
              <span aria-hidden="true">·</span>
            )}
            {dayWeight !== null && (
              <span className="tnum">
                {formatWeight(weightToKg(dayWeight, storedUnit), profile.weight_unit)}
              </span>
            )}
          </div>
        )}

        {dayEntries && dayEntries.length > 0 && (
          <div className="mt-3.5 flex flex-col gap-2">
            {dayEntries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => openEdit(entry)}
                aria-label={`Edit ${entry.name} · ${fmt(Number(entry.calories))} kcal`}
                className="flex items-center justify-between gap-3 rounded-[14px] border border-line-soft bg-raised-soft px-3 py-2.5 text-left text-[13px] transition-colors active:border-accent"
              >
                <span className="min-w-0 truncate">{entry.name}</span>
                <span className="tnum flex-none font-mono text-body">
                  {fmt(Number(entry.calories))}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="mt-5 flex items-center gap-2.5 rounded-[16px] border border-line px-3.5 py-3">
        <IconSearch size={16} className="flex-none text-faint" />
        <input
          type="text"
          inputMode="search"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search past foods"
          placeholder="Search past foods — try “salmon”"
          className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
        />
      </div>

      {results.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-2">
          {results.map((food) => (
            <button
              key={food.id}
              type="button"
              onClick={() =>
                void reAdd({
                  name: food.name,
                  calories: Number(food.calories),
                  protein_g: Number(food.protein_g),
                  carbs_g: Number(food.carbs_g),
                  fat_g: Number(food.fat_g),
                })
              }
              aria-label={`Add ${food.name} to today`}
              className="flex items-center justify-between gap-3 rounded-[14px] border border-line bg-raised-soft px-[13px] py-[11px] text-left text-[13px] transition-colors active:border-accent"
            >
              <span className="min-w-0 truncate">{food.name}</span>
              <span className="flex-none font-mono text-[11px] text-accent">
                add to today
              </span>
            </button>
          ))}
        </div>
      )}

      {searched && results.length === 0 && (
        <p className="mt-2.5 font-mono text-[11px] leading-[1.5] text-faint">
          Nothing in the last 90 days matches that yet — log it once and it&rsquo;ll be
          here next time.
        </p>
      )}
    </div>
  );
}
