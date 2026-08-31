"use client";

import { useApp } from "@/components/store";
import { StepperRow, Thumb } from "@/components/ui";
import { IconCheck, IconRetry } from "@/components/icons";
import { fmt, trim } from "@/lib/format";
import { addDays } from "@/lib/dates";
import type { AnalyzeStage } from "@/lib/types";

/* ------------------------------------------------------- processing ---- */

const STAGES: { key: AnalyzeStage; label: string }[] = [
  { key: "reading_label", label: "Reading the label…" },
  { key: "matching_saved", label: "Matching your saved foods…" },
  { key: "working_serving", label: "Working out the serving…" },
  { key: "logged", label: "Logged" },
];

/** Driven by real pipeline stages streamed from /api/analyze — the overlay is
 *  up only while work is actually in flight. */
export function ProcessingOverlay() {
  const { processing } = useApp();
  if (!processing.active) return null;

  const idx = Math.max(
    0,
    STAGES.findIndex((s) => s.key === processing.stage),
  );

  return (
    <div
      className="absolute inset-0 z-[8] flex flex-col items-center justify-center gap-[22px] p-10"
      style={{ background: "oklch(0.18 0.015 60 / .92)" }}
      role="status"
      aria-live="polite"
    >
      <div
        className="h-[120px] w-[120px] animate-pop overflow-hidden rounded-[28px] bg-cover bg-center"
        style={{
          backgroundImage: processing.preview
            ? `url(${processing.preview})`
            : "repeating-linear-gradient(135deg, oklch(0.34 0.02 60) 0 6px, oklch(0.29 0.02 60) 6px 12px)",
        }}
      />
      <div className="flex w-full flex-col gap-2.5">
        {STAGES.map((s, i) => (
          <div
            key={s.key}
            className="flex items-center gap-2.5 font-mono text-[12px]"
            style={{
              color: i <= idx ? "oklch(0.95 0.005 85)" : "oklch(0.55 0.01 70)",
            }}
          >
            <span
              className="h-1.5 w-1.5 flex-none rounded-full"
              style={{
                background:
                  i < idx
                    ? "var(--color-good)"
                    : i === idx
                      ? "var(--color-accent)"
                      : "oklch(0.4 0.01 70)",
              }}
            />
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ toast ---- */

/** The only interruption in the happy path. Undo removes the entry, Fix opens
 *  the edit sheet, Try again re-runs the pipeline on the saved evidence. */
export function ToastBar() {
  const { toast, entries, deleteEntries, openEdit, retryAnalysis, dismissToast } = useApp();
  if (!toast) return null;

  const ids = toast.entryIds ?? [];
  // Fix opens the first entry; Undo removes all of them, so a log announced as
  // "3 items" undoes as three rather than leaving two behind.
  const entry = ids.length ? entries.find((e) => e.id === ids[0]) : undefined;
  const isRetry = Boolean(toast.retry);

  return (
    <div
      className="absolute inset-x-3.5 bottom-24 z-[7] flex animate-rise-toast items-center gap-3 rounded-[22px] bg-toast px-4 py-3.5 text-[oklch(0.97_0.005_85)] shadow-toast"
      role="status"
      aria-live="polite"
    >
      <Thumb src={toast.photo ?? entry?.photo_url} size={38} radius={12} dark />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-bold">{toast.title}</span>
        <span className="tnum mt-0.5 truncate font-mono text-[11px] text-[oklch(0.8_0.01_80)]">
          {toast.line}
        </span>
      </span>

      {isRetry ? (
        <button
          type="button"
          onClick={() => {
            const r = toast.retry;
            dismissToast();
            if (r) void retryAnalysis(r.evidenceIds, r.localDate);
          }}
          className="flex flex-none items-center gap-1.5 rounded-[12px] bg-white/[0.14] px-2.5 py-2 text-[12px] font-bold"
        >
          <IconRetry size={13} />
          Try again
        </button>
      ) : (
        ids.length > 0 && (
          <>
            {entry && (
              <button
                type="button"
                onClick={() => openEdit(entry)}
                className="flex-none rounded-[12px] bg-white/[0.14] px-2.5 py-2 text-[12px] font-bold"
              >
                Fix
              </button>
            )}
            <button
              type="button"
              onClick={() => void deleteEntries(ids)}
              className="flex-none px-2.5 py-2 text-[12px] font-bold text-[oklch(0.78_0.08_60)]"
            >
              Undo
            </button>
          </>
        )
      )}
    </div>
  );
}

/* -------------------------------------------------------- edit sheet --- */

export function EditSheet() {
  const { editing, setDraft, saveEdit, closeEdit, deleteEntry, moveEntry, today } =
    useApp();
  if (!editing) return null;

  const { entry, draft } = editing;
  const onToday = entry.local_date === today;

  return (
    <div
      className="absolute inset-0 z-[9] flex flex-col justify-end"
      style={{ background: "oklch(0.2 0.02 60 / .4)" }}
      onClick={closeEdit}
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${entry.name}`}
    >
      <div
        className="no-scrollbar max-h-[88%] animate-rise-fast overflow-y-auto rounded-t-[30px] bg-raised px-5 pt-5 pb-[26px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-[38px] rounded-full bg-[oklch(0.86_0.012_80)]" />

        <div className="mb-4 flex items-center gap-3">
          <Thumb src={entry.photo_url} size={56} radius={16} alt={entry.name} />
          <div className="min-w-0 flex-1">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ name: e.target.value })}
              aria-label="Food name"
              className="w-full border-none bg-transparent text-[17px] font-extrabold tracking-[-0.01em] text-ink outline-none"
            />
            <div className="mt-[3px] truncate font-mono text-[11px] text-muted">
              {entry.source_label ?? "Manual entry"}
            </div>
          </div>
        </div>

        {entry.reasoning && (
          <p className="mb-4 rounded-[16px] border border-accent-wash-line bg-accent-wash px-[15px] py-[13px] text-[12.5px] leading-[1.5] text-balance">
            {entry.reasoning}
          </p>
        )}

        <div className="flex flex-col gap-[9px]">
          <StepperRow
            variant="sheet"
            label="Calories"
            value={draft.cal}
            step={5}
            format={fmt}
            onChange={(cal) => setDraft({ cal })}
          />
          <StepperRow
            variant="sheet"
            label="Protein"
            value={draft.p}
            step={1}
            format={trim}
            suffix="g"
            onChange={(p) => setDraft({ p })}
          />
          <StepperRow
            variant="sheet"
            label="Carbs"
            value={draft.c}
            step={1}
            format={trim}
            suffix="g"
            onChange={(c) => setDraft({ c })}
          />
          <StepperRow
            variant="sheet"
            label="Fat"
            value={draft.f}
            step={0.5}
            format={trim}
            suffix="g"
            onChange={(f) => setDraft({ f })}
          />
          <StepperRow
            variant="sheet"
            label="Quantity"
            value={draft.qty}
            step={0.5}
            format={trim}
            suffix="×"
            onChange={(qty) => setDraft({ qty })}
          />
        </div>

        {/* Date / time / notes — PRD §21 makes these editable too. */}
        <div className="mt-[9px] flex gap-2">
          <label className="flex flex-1 items-center justify-between gap-2 rounded-[15px] border border-line px-3.5 py-[11px]">
            <span className="text-[13.5px] font-semibold">Date</span>
            <input
              type="date"
              value={draft.date}
              onChange={(e) => setDraft({ date: e.target.value })}
              className="tnum bg-transparent text-right font-mono text-[12px] outline-none"
            />
          </label>
          <label className="flex flex-none items-center gap-2 rounded-[15px] border border-line px-3.5 py-[11px]">
            <span className="text-[13.5px] font-semibold">Time</span>
            <input
              type="time"
              value={draft.time}
              onChange={(e) => setDraft({ time: e.target.value })}
              className="tnum bg-transparent text-right font-mono text-[12px] outline-none"
            />
          </label>
        </div>

        <input
          value={draft.notes}
          onChange={(e) => setDraft({ notes: e.target.value })}
          placeholder="Notes (optional)"
          className="mt-[9px] w-full rounded-[15px] border border-line px-3.5 py-[11px] text-[13.5px] outline-none placeholder:text-faint"
        />

        <div className="mt-3.5 flex gap-2">
          <button
            type="button"
            onClick={() => void moveEntry(entry, -1)}
            className="flex-1 rounded-[15px] border border-dashed border-line-dashed px-3 py-3 text-[12.5px] font-bold text-body"
          >
            {onToday ? "Move to yesterday" : `Move to ${addDays(entry.local_date, -1)}`}
          </button>
          <button
            type="button"
            onClick={() => void deleteEntry(entry.id)}
            className="flex-none rounded-[15px] border border-danger-line px-4 py-3 text-[12.5px] font-bold text-danger"
          >
            Delete
          </button>
        </div>

        <div className="mt-2.5 flex gap-2 pb-[env(safe-area-inset-bottom)]">
          <button
            type="button"
            onClick={closeEdit}
            className="flex-none rounded-[18px] border border-line-stepper px-5 py-[15px] text-[14px] font-bold text-body"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void saveEdit()}
            className="flex-1 rounded-[18px] bg-accent py-[15px] text-[14px] font-bold text-surface"
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ celebration ---- */

export function Celebration() {
  const { celebrate, closeCelebrate, todayTotals, targets } = useApp();
  if (!celebrate) return null;

  return (
    <div
      className="absolute inset-0 z-10 flex animate-pop-fast flex-col items-center justify-center gap-4 p-10 text-center"
      style={{ background: "oklch(0.99 0.01 85 / .96)" }}
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-good text-[oklch(0.99_0.01_150)]">
        <IconCheck size={40} />
      </div>
      <h2 className="text-[24px] font-extrabold tracking-[-0.02em]">
        You filled the tank
      </h2>
      <p className="tnum font-mono text-[15px] text-body">
        {fmt(todayTotals.cal)} / {fmt(Number(targets.calories_target))} kcal
      </p>
      <p className="max-w-[26ch] text-[14px] leading-[1.5] text-muted">
        Anything past this is bonus. Nice work — that&rsquo;s the surplus doing
        its job.
      </p>
      <button
        type="button"
        onClick={closeCelebrate}
        className="mt-2 rounded-[18px] bg-ink px-[26px] py-3.5 text-[14px] font-bold text-[oklch(0.98_0.005_85)]"
      >
        Keep going
      </button>
    </div>
  );
}

/* -------------------------------------------------------- trial wall --- */

/** Shown when an analysis is refused. Deliberately not a hard lock: quick-add,
 *  editing, weight, history and trends all still work, because the only thing
 *  the trial meters is the model call. */
export function TrialWall() {
  const { wall, dismissWall } = useApp();
  if (!wall) return null;

  const expired = wall.reason === "expired";
  // Empty is a real state — a deployment that never set a contact address. The
  // wall still has to explain itself, so the mailto degrades to plain text
  // rather than becoming a link to "mailto:".
  const email = wall.contact_email?.trim() || null;

  return (
    <div
      className="absolute inset-0 z-[11] flex animate-pop-fast flex-col items-center justify-center gap-4 p-9 text-center"
      style={{ background: "oklch(0.99 0.01 85 / .97)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Trial ended"
    >
      <div className="flex h-[84px] w-[84px] items-center justify-center rounded-full bg-accent-wash">
        <span className="tnum font-mono text-[26px] font-bold text-accent">
          {expired ? `${wall.trial_days ?? 14}d` : wall.analyses_used}
        </span>
      </div>

      <h2 className="text-[24px] font-extrabold tracking-[-0.02em] text-balance">
        {expired ? "Your trial's up" : "That's the last free analysis"}
      </h2>

      <p className="max-w-[30ch] text-[14px] leading-[1.5] text-muted text-balance">
        {expired
          ? `The free trial runs ${wall.trial_days ?? 14} days. Yours has run out — everything you logged is still here.`
          : `The free trial covers ${wall.analyses_limit ?? 150} photo analyses and you've used them all. Everything you logged is still here.`}
      </p>

      {email && (
        <>
          <a
            href={`mailto:${email}?subject=${encodeURIComponent("MacroTrack — upgrade to a paid account")}`}
            className="mt-1 rounded-[18px] bg-accent px-6 py-3.5 text-[14px] font-bold text-surface"
          >
            Email to keep going
          </a>
          <p className="font-mono text-[11px] text-faint">{email}</p>
        </>
      )}

      <div className="mt-3 max-w-[32ch] rounded-[18px] border border-line bg-raised px-4 py-3 text-[12.5px] leading-[1.5] text-muted text-balance">
        Photo logging is what pauses. Your history, weight, trends and one-tap
        re-adds all still work.
      </div>

      <button
        type="button"
        onClick={dismissWall}
        className="mt-1 px-4 py-2 text-[13px] font-semibold text-faint"
      >
        Back to my log
      </button>
    </div>
  );
}

/* ------------------------------------------------------- trial notice -- */

/** A quiet line on Today while the trial is still running. Only appears once
 *  it is worth knowing about — nagging from day one would be noise. */
export function TrialNotice() {
  const { trial, setScreen } = useApp();
  if (trial.unlimited || trial.blocked) return null;

  const days = trial.days_left ?? 0;
  const left = trial.analyses_left ?? 0;
  const worthSaying = days <= 5 || left <= 25;
  if (!worthSaying) return null;

  const line =
    days <= 5 && days <= Math.ceil(left / 5)
      ? `${days} day${days === 1 ? "" : "s"} left in your trial`
      : `${left} photo analys${left === 1 ? "is" : "es"} left in your trial`;

  return (
    <button
      type="button"
      onClick={() => setScreen("settings")}
      className="mb-3 flex w-full items-center justify-between rounded-[16px] border border-accent-wash-line bg-accent-wash px-4 py-2.5 text-left"
    >
      <span className="text-[12.5px] font-semibold text-accent-quiet">{line}</span>
      <span className="font-mono text-[11px] text-accent">details</span>
    </button>
  );
}
