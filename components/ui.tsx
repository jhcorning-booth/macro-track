"use client";

import { useEffect, useRef, useState } from "react";
import { IconMinus, IconPlus } from "./icons";
import type { Confidence } from "@/lib/types";

/* ---------------------------------------------------------------- thumb */

const STRIPES =
  "repeating-linear-gradient(135deg, oklch(0.9 0.02 80) 0 4px, oklch(0.95 0.012 80) 4px 8px)";
const STRIPES_DARK =
  "repeating-linear-gradient(135deg, oklch(0.4 0.02 60) 0 4px, oklch(0.34 0.02 60) 4px 8px)";

/** The user's capture when there is one; the prototype's diagonal-stripe
 *  placeholder when there isn't (quick-adds and typed entries have no photo). */
export function Thumb({
  src,
  size = 46,
  radius = 14,
  dark = false,
  alt = "",
}: {
  src?: string | null;
  size?: number;
  radius?: number;
  dark?: boolean;
  alt?: string;
}) {
  return (
    <span
      className="block flex-none overflow-hidden bg-cover bg-center"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundImage: src ? `url(${src})` : dark ? STRIPES_DARK : STRIPES,
      }}
      role={src ? "img" : undefined}
      aria-label={src ? alt : undefined}
    />
  );
}

/* ------------------------------------------------------- confidence pill */

const CONF: Record<Confidence, { label: string; bg: string; fg: string }> = {
  high: { label: "confirmed", bg: "var(--color-conf-high-bg)", fg: "var(--color-conf-high-fg)" },
  medium: { label: "likely", bg: "var(--color-conf-med-bg)", fg: "var(--color-conf-med-fg)" },
  low: { label: "estimated", bg: "var(--color-conf-low-bg)", fg: "var(--color-conf-low-fg)" },
};

export function ConfidencePill({ confidence }: { confidence: Confidence }) {
  const c = CONF[confidence] ?? CONF.medium;
  return (
    <span
      className="flex-none rounded-[6px] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.06em]"
      style={{ background: c.bg, color: c.fg }}
    >
      {c.label}
    </span>
  );
}

/* ------------------------------------------------------------ stat card */

export function StatCard({
  label,
  value,
  sub,
  valueSize = 20,
}: {
  label: string;
  value: string;
  sub?: string;
  valueSize?: number;
}) {
  return (
    <div className="rounded-[18px] border border-line bg-raised p-3.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
        {label}
      </div>
      <div
        className="tnum mt-1.5 font-mono font-bold"
        style={{ fontSize: valueSize }}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

/* -------------------------------------------------------------- stepper */

type StepperVariant = "settings" | "sheet" | "onboard";

const V: Record<
  StepperVariant,
  { row: string; btn: number; btnRadius: number; value: number; minW: number; label: string }
> = {
  settings: {
    row: "px-4 py-3.5 rounded-[18px] border border-line bg-raised",
    btn: 34,
    btnRadius: 11,
    value: 15,
    minW: 54,
    label: "text-[14px] font-bold",
  },
  sheet: {
    row: "px-3.5 py-[11px] rounded-[15px] border border-line",
    btn: 31,
    btnRadius: 10,
    value: 14,
    minW: 52,
    label: "text-[13.5px] font-semibold",
  },
  onboard: {
    row: "p-4 rounded-[20px] border border-[oklch(0.91_0.012_80)] bg-sunken",
    btn: 34,
    btnRadius: 11,
    value: 16,
    minW: 56,
    label: "text-[14px] font-bold",
  },
};

/** A −/+ row whose value is also directly editable: tap the number and type.
 *  Steppers alone are too slow for a 300 g carb target. */
export function StepperRow({
  label,
  hint,
  value,
  step,
  min = 0,
  max,
  format,
  suffix,
  onChange,
  variant = "settings",
}: {
  label: string;
  hint?: string;
  value: number;
  step: number;
  min?: number;
  max?: number;
  /** How the value reads when not being edited, e.g. "2,850" or "3.5 g". */
  format: (n: number) => string;
  suffix?: string;
  onChange: (next: number) => void;
  variant?: StepperVariant;
}) {
  const v = V[variant];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const clamp = (n: number) =>
    Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, n));

  const bump = (dir: 1 | -1) => {
    const next = clamp(Math.round((value + dir * step) * 100) / 100);
    if (next !== value) onChange(next);
  };

  const commit = () => {
    const n = Number.parseFloat(draft.replace(/[^0-9.]/g, ""));
    setEditing(false);
    if (Number.isFinite(n)) onChange(clamp(Math.round(n * 100) / 100));
  };

  return (
    <div className={`flex items-center justify-between gap-3 ${v.row}`}>
      <div className="min-w-0">
        <div className={v.label}>{label}</div>
        {hint && <div className="mt-px text-[11px] text-faint">{hint}</div>}
      </div>

      <div className="flex flex-none items-center gap-2">
        <button
          type="button"
          onClick={() => bump(-1)}
          aria-label={`Decrease ${label}`}
          className="flex items-center justify-center border border-line-stepper bg-[oklch(0.98_0.006_85)] text-ink transition-colors active:bg-line"
          style={{ width: v.btn, height: v.btn, borderRadius: v.btnRadius }}
        >
          <IconMinus size={v.btn * 0.46} />
        </button>

        {editing ? (
          <input
            ref={inputRef}
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="tnum rounded-[8px] bg-line/40 text-center font-mono font-bold outline-none"
            style={{ fontSize: v.value, minWidth: v.minW, width: v.minW }}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(String(value));
              setEditing(true);
            }}
            aria-label={`Edit ${label}`}
            className="tnum text-center font-mono font-bold"
            style={{ fontSize: v.value, minWidth: v.minW }}
          >
            {format(value)}
            {suffix ? <span className="ml-1">{suffix}</span> : null}
          </button>
        )}

        <button
          type="button"
          onClick={() => bump(1)}
          aria-label={`Increase ${label}`}
          className="flex items-center justify-center border border-line-stepper bg-[oklch(0.98_0.006_85)] text-ink transition-colors active:bg-line"
          style={{ width: v.btn, height: v.btn, borderRadius: v.btnRadius }}
        >
          <IconPlus size={v.btn * 0.46} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- section */

export function SectionTitle({
  children,
  right,
  className = "",
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <span className="text-[15px] font-bold">{children}</span>
      {right && <span className="font-mono text-[11px] text-faint">{right}</span>}
    </div>
  );
}

export function ScreenTitle({
  title,
  sub,
}: {
  title: string;
  sub?: React.ReactNode;
}) {
  return (
    <div>
      <h1 className="text-[22px] font-extrabold tracking-[-0.02em]">{title}</h1>
      {sub && (
        <p className="mt-0.5 text-[13px] leading-[1.45] text-muted text-balance">{sub}</p>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- toggle */

export function Toggle({ on }: { on: boolean }) {
  return (
    <span
      className="flex h-[26px] w-11 flex-none rounded-full p-[3px] transition-all duration-200"
      style={{
        background: on ? "var(--color-accent)" : "oklch(0.88 0.012 80)",
        justifyContent: on ? "flex-end" : "flex-start",
      }}
    >
      <span className="block h-5 w-5 rounded-full bg-white shadow-knob" />
    </span>
  );
}
