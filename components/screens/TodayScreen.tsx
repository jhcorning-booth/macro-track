"use client";

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/components/store";
import { ConfidencePill, SectionTitle, Thumb } from "@/components/ui";
import { heroState, macroRows } from "@/lib/calc";
import { compactLine, fmt, macroLine, timeLabel } from "@/lib/format";
import { headerDate } from "@/lib/dates";

/** Eases a changing number rather than snapping it — the totals visibly climb
 *  when an entry lands, which is the whole point of the shutter loop.
 *
 *  The animation always starts from what is currently on screen (tracked in a
 *  ref, mirroring `shown`), never from a "previous value" written in cleanup:
 *  under StrictMode the cleanup runs immediately after the first effect pass,
 *  so a cleanup-written start point would equal the target on the second pass
 *  and the number would freeze at its old value forever. */
function useCountUp(value: number, ms = 650) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + (value - from) * eased;
      shownRef.current = next;
      setShown(next);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);

    // rAF is frozen in a backgrounded tab, so the eased path alone can leave a
    // stale number on screen. The timer guarantees the exact value lands
    // whether or not a single frame ever runs.
    const settle = setTimeout(() => {
      shownRef.current = value;
      setShown(value);
    }, ms + 120);

    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      clearTimeout(settle);
    };
  }, [value, ms]);

  return shown;
}

export default function TodayScreen() {
  const {
    profile,
    today,
    targets,
    entries,
    savedFoods,
    todayTotals,
    setScreen,
    openEdit,
    quickAdd,
    weights,
  } = useApp();

  const hero = heroState(todayTotals.cal, Number(targets.calories_target));
  const macros = macroRows(todayTotals, targets);
  const shownCal = useCountUp(todayTotals.cal);

  const todayWeight =
    weights.find((w) => w.local_date === today)?.weight ??
    weights[weights.length - 1]?.weight ??
    null;

  return (
    <div className="px-5 pt-1.5 pb-[120px]">
      {/* ------------------------------------------------------- header */}
      <div className="mb-[18px] flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold tracking-[-0.02em]">
            {hero.greeting}
          </h1>
          <p className="mt-0.5 text-[13px] text-muted">
            {headerDate(today)} · {profile.goal_label}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setScreen("weight")}
          className="flex flex-none flex-col items-end gap-px rounded-[14px] border border-line-chip bg-[oklch(0.99_0.004_85)] px-3 py-2"
        >
          <span className="tnum font-mono text-[15px] font-bold text-ink">
            {todayWeight === null ? "—" : Number(todayWeight).toFixed(1)}
          </span>
          <span className="text-[10px] uppercase tracking-[0.08em] text-faint">
            lb today
          </span>
        </button>
      </div>

      {/* --------------------------------------------- hero · fill gauge */}
      <div className="flex items-stretch gap-5 rounded-[28px] border border-[oklch(0.91_0.012_80)] bg-sunken p-5">
        <div className="relative flex w-[104px] flex-none flex-col justify-end overflow-hidden rounded-[22px] bg-gauge-track">
          <div
            className="w-full"
            style={{
              height: `${hero.fillPct.toFixed(1)}%`,
              background: hero.hit ? "var(--color-good)" : "var(--color-accent)",
              transition: "height .7s cubic-bezier(.2,.8,.2,1)",
            }}
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
            <span className="tnum font-mono text-[26px] font-bold text-ink-deep">
              {hero.pctLabel}
            </span>
            <span className="text-[10px] uppercase tracking-[0.1em] text-ink-soft">
              filled
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-between gap-3.5">
          <div>
            {/* The design frame is 392px; a 4-digit total plus the target
                overflows a 375px phone, so both steps down a notch there. */}
            <div className="flex flex-nowrap items-baseline gap-1.5 whitespace-nowrap">
              <span className="tnum font-mono text-[31px] leading-none font-bold tracking-[-0.03em] min-[392px]:text-[36px]">
                {fmt(shownCal)}
              </span>
              <span className="tnum font-mono text-[13px] text-muted min-[392px]:text-[15px]">
                / {fmt(Number(targets.calories_target))}
              </span>
            </div>
            <p
              className="mt-1.5 text-[14px] font-semibold text-balance"
              style={{ color: hero.hit ? "var(--color-good)" : "var(--color-ink)" }}
            >
              {hero.statusLine}
            </p>
          </div>

          <div className="flex flex-col gap-[9px]">
            {macros.map((m) => (
              <div key={m.key} className="flex flex-col gap-1">
                <div className="tnum flex justify-between font-mono text-[11px] text-body">
                  <span>{m.label}</span>
                  <span>{m.text}</span>
                </div>
                <div className="h-[5px] overflow-hidden rounded-[3px] bg-track-soft">
                  <div
                    className="h-full rounded-[3px]"
                    style={{
                      width: `${m.pct}%`,
                      background: m.colorVar,
                      transition: "width .5s ease",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------- today's log */}
      <SectionTitle
        className="mx-0.5 mt-[26px] mb-3"
        right={`${entries.length} item${entries.length === 1 ? "" : "s"}`}
      >
        Today&rsquo;s log
      </SectionTitle>

      {entries.length === 0 ? (
        <div className="rounded-[20px] border border-dashed border-line-dashed bg-[oklch(0.975_0.01_80)] px-4 py-6 text-center">
          <p className="text-[14px] font-bold">Nothing in the tank yet</p>
          <p className="mx-auto mt-1.5 max-w-[28ch] text-[12.5px] leading-[1.5] text-muted text-balance">
            Tap the shutter and photograph whatever you&rsquo;re about to eat. No
            searching, no serving math.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {entries.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => openEdit(e)}
              className="flex animate-rise items-center gap-3 rounded-[20px] border border-line bg-raised-soft p-3 text-left transition-colors hover:border-[oklch(0.8_0.03_70)]"
            >
              <Thumb src={e.photo_url} alt={e.name} />

              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[14px] font-bold">{e.name}</span>
                  <ConfidencePill confidence={e.confidence} />
                </span>
                <span className="tnum font-mono text-[11px] text-muted">
                  {macroLine(Number(e.protein_g), Number(e.carbs_g), Number(e.fat_g))}
                </span>
              </span>

              <span className="flex flex-none flex-col items-end gap-0.5">
                <span className="tnum font-mono text-[16px] font-bold">
                  {fmt(Number(e.calories))}
                </span>
                <span className="text-[10px] text-faint-alt">
                  {timeLabel(e.consumed_at, profile.timezone)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ------------------------------------------------ one tap again */}
      {savedFoods.length > 0 && (
        <>
          <div className="mx-0.5 mt-6 mb-2.5 text-[15px] font-bold">
            One tap again
          </div>
          <div className="no-scrollbar -mx-5 flex gap-2.5 overflow-x-auto px-5 pb-1">
            {savedFoods.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => void quickAdd(f)}
                className="w-[164px] flex-none rounded-[18px] border border-dashed border-line-dashed bg-[oklch(0.975_0.01_80)] px-3.5 py-3 text-left transition-colors hover:border-accent hover:bg-[oklch(0.96_0.02_70)]"
              >
                <div className="mb-1 truncate text-[13px] font-bold">{f.name}</div>
                <div className="tnum font-mono text-[10px] whitespace-nowrap text-muted">
                  {compactLine(
                    Number(f.calories),
                    Number(f.protein_g),
                    Number(f.carbs_g),
                    Number(f.fat_g),
                  )}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
