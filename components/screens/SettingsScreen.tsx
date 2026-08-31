"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useApp } from "@/components/store";
import { ScreenTitle, SectionTitle, StepperRow, Toggle } from "@/components/ui";
import { SetupCalculator } from "@/components/SetupCalculator";
import { ensurePushSubscription, pushSupported } from "@/lib/push";
import { fmt, trim } from "@/lib/format";

/** Read once per render, not subscribed to — the browser has no change event
 *  for permission or for its own zone, and `allow` reports the new value
 *  directly. */
const NO_SUBSCRIBE = () => () => {};
import { browserTimeZone, RETENTION_DAYS } from "@/lib/dates";
import type { NudgeKind, Targets } from "@/lib/types";

/* --------------------------------------------------------------- constants */

const NUDGE_ROWS: { kind: NudgeKind; label: string; example: string }[] = [
  {
    kind: "no_logging",
    label: "Nothing logged yet",
    example: "“Morning — nothing in the tank yet.”",
  },
  {
    kind: "calories_remaining",
    label: "Calories remaining",
    example: "“720 to go. One shake covers most of it.”",
  },
  {
    kind: "target_reached",
    label: "Target reached",
    example: "“Tank full. Anything else is bonus.”",
  },
  {
    kind: "protein_checkin",
    label: "Protein check-in",
    example: "“35 g short on protein — easy fix.”",
  },
  {
    kind: "evening_nudge",
    label: "Evening nudge",
    example: "“540 below target with a few hours left.”",
  },
];

/** Fallbacks match the store's own upsert defaults so a missing row and a
 *  toggled row never disagree about what "on" means. */
const NUDGE_DEFAULT_ON = true;
const NUDGE_DEFAULT_TIME = "10:00";

const TARGET_FALLBACK: Targets = {
  calories_target: 2850,
  protein_target_g: 200,
  carbs_target_g: 300,
  fat_target_g: 80,
};

const SAVE_DEBOUNCE_MS = 500;

/** Only for browsers without `Intl.supportedValuesOf` (older WebKit). Not a
 *  world tour — enough to pick from, with the saved and detected zones merged
 *  in on top so the control is never blank. */
const FALLBACK_ZONES = [
  "America/Anchorage",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/New_York",
  "America/Phoenix",
  "America/Sao_Paulo",
  "America/Toronto",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Asia/Kolkata",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/Berlin",
  "Europe/Dublin",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Paris",
  "Pacific/Auckland",
  "Pacific/Honolulu",
  "UTC",
];

const ROW =
  "rounded-[18px] border border-line bg-raised px-4 py-3.5 text-[13.5px]";
const NOTE = "mt-1 text-[11.5px] leading-[1.45] text-[oklch(0.56_0.02_70)]";

type PushState =
  | "unknown"
  | "unsupported"
  | "default"
  | "granted"
  | "denied"
  | "error";

/* ----------------------------------------------------------------- helpers */

/** numeric() columns arrive as strings from PostgREST — never trust the type. */
function num(value: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTargets(t: Targets): Targets {
  return {
    calories_target: num(t.calories_target, TARGET_FALLBACK.calories_target),
    protein_target_g: num(t.protein_target_g, TARGET_FALLBACK.protein_target_g),
    carbs_target_g: num(t.carbs_target_g, TARGET_FALLBACK.carbs_target_g),
    fat_target_g: num(t.fat_target_g, TARGET_FALLBACK.fat_target_g),
  };
}

/** Enumerated once per session: the list is static, and useSyncExternalStore
 *  needs the same array back every read or it re-renders forever. */
let zoneCache: string[] | null = null;

function supportedZones(): string[] {
  if (!zoneCache) {
    zoneCache =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : FALLBACK_ZONES;
  }
  return zoneCache;
}

/** Postgres `time` comes back as "10:00:00"; <input type="time"> wants "10:00". */
function hhmm(sendAt: string | null | undefined): string {
  const s = String(sendAt ?? NUDGE_DEFAULT_TIME);
  return /^\d{2}:\d{2}/.test(s) ? s.slice(0, 5) : NUDGE_DEFAULT_TIME;
}

/* ------------------------------------------------------------------- rows */

function PrefRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${ROW}`}>
      <span className="font-bold">{label}</span>
      <span className="tnum font-mono text-muted">{value}</span>
    </div>
  );
}

/** The row is one big switch, so the whole card is the tap target. The time
 *  picker is a sibling laid over the card's top-right corner rather than a
 *  child of the button — a control inside a button would be invalid markup. */
function NudgeRow({
  label,
  example,
  on,
  time,
  scheduled,
  onToggle,
  onTime,
}: {
  label: string;
  example: string;
  on: boolean;
  time: string;
  scheduled: boolean;
  onToggle: () => void;
  onTime: (value: string) => void;
}) {
  return (
    <div className="relative rounded-[18px] border border-line bg-raised">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={on}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-bold">{label}</span>
          <span className="mt-0.5 block text-[11.5px] leading-[1.4] text-[oklch(0.56_0.02_70)]">
            {example}
          </span>
        </span>
        <span className="flex flex-none flex-col items-end gap-1.5">
          {/* reserves the line the time picker floats in, so the toggle sits under it */}
          <span className="block h-4" aria-hidden="true" />
          <Toggle on={on} />
        </span>
      </button>

      <div className="pointer-events-none absolute right-4 top-3.5 flex h-4 items-center">
        {scheduled ? (
          /* 92px fits "10:00 AM" plus the native picker indicator; the
             meridiem was clipped at anything narrower. */
          <input
            type="time"
            value={time}
            onChange={(e) => {
              if (e.target.value) onTime(e.target.value);
            }}
            aria-label={`${label} — time to send`}
            className="tnum pointer-events-auto w-[92px] appearance-none border-0 bg-transparent p-0 text-right font-mono text-[11px] text-muted outline-none"
          />
        ) : (
          <span className="font-mono text-[11px] text-faint">when you cross</span>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- screen */

export default function SettingsScreen() {
  const {
    profile,
    targets,
    saveTargets,
    nudges,
    toggleNudge,
    setNudgeTime,
    setTimezone,
    setOnboard,
    signOut,
    trial,
  } = useApp();

  /* ---- targets: instant on screen, one write ~500 ms after the last tap */

  const [local, setLocal] = useState<Targets>(() => normalizeTargets(targets));
  const localRef = useRef(local);
  const pending = useRef<Targets | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(saveTargets);

  useEffect(() => {
    localRef.current = local;
  }, [local]);

  useEffect(() => {
    saveRef.current = saveTargets;
  });

  // Re-seed when targets change elsewhere (onboarding), never mid-edit.
  useEffect(() => {
    if (!pending.current) setLocal(normalizeTargets(targets));
  }, [targets]);

  const flush = useCallback(() => {
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) void saveRef.current(next);
  }, []);

  // Leaving Settings must not drop a target the user just dialed in.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const next = pending.current;
      pending.current = null;
      if (next) void saveRef.current(next);
    },
    [],
  );

  const bump = useCallback(
    (patch: Partial<Targets>) => {
      const next = { ...(pending.current ?? localRef.current), ...patch };
      setLocal(next);
      pending.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  /* ----------------------------------------------------------- time zone */

  // The server's zone list and its host zone are not the browser's, so both are
  // read through useSyncExternalStore with a server snapshot the server can
  // actually stand behind — otherwise hydration mismatches on the options.
  const zones = useSyncExternalStore(
    NO_SUBSCRIBE,
    supportedZones,
    () => FALLBACK_ZONES,
  );
  const deviceZone = useSyncExternalStore(
    NO_SUBSCRIBE,
    browserTimeZone,
    () => profile.timezone,
  );

  const [pendingZone, setPendingZone] = useState<string | null>(null);
  const zone = pendingZone ?? profile.timezone;

  const zoneOptions = useMemo(() => {
    // The saved zone and this device's must always be selectable even if the
    // list somehow omits them — a blank control can't be recovered from.
    const all = new Set(zones);
    all.add(profile.timezone);
    all.add(deviceZone);
    return [...all].sort();
  }, [zones, profile.timezone, deviceZone]);

  /** The pending value holds the row on the new zone while the write is in
   *  flight, then clears either way — a failure must show what is saved. */
  const pickZone = useCallback(
    async (tz: string) => {
      if (tz === profile.timezone) return;
      setPendingZone(tz);
      try {
        await setTimezone(tz);
      } finally {
        // Without the finally, a throw would leave the select disabled with no
        // way back except a reload.
        setPendingZone(null);
      }
    },
    [profile.timezone, setTimezone],
  );

  /* ---------------------------------------------------------------- push */

  // Notification.permission doesn't exist during SSR, so it's read through
  // useSyncExternalStore (with an "unknown" server snapshot) rather than an
  // effect — no hydration mismatch, no cascading render.
  const detected = useSyncExternalStore<PushState>(
    NO_SUBSCRIBE,
    () => (pushSupported() ? (Notification.permission as PushState) : "unsupported"),
    () => "unknown",
  );
  const [override, setOverride] = useState<PushState | null>(null);
  const push = override ?? detected;
  const [asking, setAsking] = useState(false);
  const [calcOpen, setCalcOpen] = useState(false);

  const allow = useCallback(async () => {
    setAsking(true);
    try {
      setOverride(await ensurePushSubscription());
    } finally {
      setAsking(false);
    }
  }, []);

  const anyNudgeOn = NUDGE_ROWS.some(
    (r) => nudges.find((n) => n.kind === r.kind)?.enabled ?? NUDGE_DEFAULT_ON,
  );

  return (
    <div className="px-5 pt-2 pb-[120px]">
      <ScreenTitle
        title="Settings"
        sub="Changes apply to today and forward. Past days keep their old targets."
      />

      {/* ------------------------------------------------------- targets */}

      <div className="mt-[18px] flex flex-col gap-2.5">
        <StepperRow
          label="Calories"
          hint="kcal per day"
          value={local.calories_target}
          step={50}
          min={500}
          format={fmt}
          onChange={(n) => bump({ calories_target: n })}
        />
        <StepperRow
          label="Protein"
          hint="grams"
          value={local.protein_target_g}
          step={5}
          min={5}
          format={trim}
          suffix="g"
          onChange={(n) => bump({ protein_target_g: n })}
        />
        <StepperRow
          label="Carbohydrates"
          hint="grams"
          value={local.carbs_target_g}
          step={10}
          min={10}
          format={trim}
          suffix="g"
          onChange={(n) => bump({ carbs_target_g: n })}
        />
        <StepperRow
          label="Fat"
          hint="grams"
          value={local.fat_target_g}
          step={5}
          min={5}
          format={trim}
          suffix="g"
          onChange={(n) => bump({ fat_target_g: n })}
        />
      </div>

      {/* -------------------------------------------------------- nudges */}

      <SectionTitle className="mx-0.5 mt-[22px] mb-2.5">Nudges</SectionTitle>

      <div className="flex flex-col gap-2.5">
        {NUDGE_ROWS.map(({ kind, label, example }) => {
          const pref = nudges.find((n) => n.kind === kind);
          return (
            <NudgeRow
              key={kind}
              label={label}
              example={example}
              on={pref?.enabled ?? NUDGE_DEFAULT_ON}
              time={hhmm(pref?.send_at)}
              // Target reached fires the moment you cross, not on a clock.
              scheduled={kind !== "target_reached"}
              onToggle={() => void toggleNudge(kind)}
              onTime={(v) => void setNudgeTime(kind, v)}
            />
          );
        })}
      </div>

      {anyNudgeOn && push !== "unknown" && (
        <div className="mt-2.5">
          {push === "granted" ? (
            <div className="rounded-[18px] border border-line bg-raised px-4 py-3.5 text-[13.5px] font-bold text-good">
              Notifications are on.
            </div>
          ) : push === "unsupported" ? (
            <div className="rounded-[18px] border border-line bg-raised px-4 py-3.5">
              <div className="text-[13.5px] font-bold">
                This browser can&rsquo;t send notifications
              </div>
              <div className={NOTE}>
                Your nudges will be waiting the next time you open the app.
              </div>
            </div>
          ) : (
            <div className="rounded-[18px] border border-dashed border-line-dashed px-4 py-3.5">
              <div className="text-[13.5px] font-bold">Turn on notifications</div>
              <div className={NOTE}>
                Nudges need permission from your browser. Install to the Home
                Screen first if you&rsquo;re on iPhone.
              </div>
              {push === "denied" && (
                <div className={NOTE}>
                  Blocked right now — you can switch them back on in your
                  browser&rsquo;s site settings.
                </div>
              )}
              {push === "error" && (
                <div className={NOTE}>
                  Permission is granted, but this device couldn&rsquo;t register
                  for push. Try again in a moment — the toggles above are saved
                  either way.
                </div>
              )}
              <button
                type="button"
                onClick={() => void allow()}
                disabled={asking}
                className="mt-2.5 text-[13.5px] font-bold text-accent disabled:text-disabled"
              >
                {asking
                  ? "Asking…"
                  : push === "error"
                    ? "Try again"
                    : "Allow notifications"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------- work it out */}

      <SectionTitle className="mx-0.5 mt-[22px] mb-2.5">
        Not sure what to aim for?
      </SectionTitle>

      {calcOpen ? (
        <div className="flex flex-col gap-2.5">
          <SetupCalculator onDone={() => setCalcOpen(false)} />
          <button
            type="button"
            onClick={() => setCalcOpen(false)}
            className="py-2 text-[13px] font-semibold text-faint"
          >
            Close
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCalcOpen(true)}
          className="w-full rounded-[18px] border border-dashed border-line-dashed px-4 py-3.5 text-left"
        >
          <span className="block text-[13.5px] font-bold text-accent">
            Work out a target from your body
          </span>
          <span className={NOTE}>
            Height, weight and where you want to get to, turned into a starting
            point. You can edit it after, and you never have to use it — the
            targets above are always yours to set directly.
          </span>
        </button>
      )}

      {/* ---------------------------------------------------------- plan */}

      <SectionTitle className="mx-0.5 mt-[22px] mb-2.5">Plan</SectionTitle>

      {trial.unlimited ? (
        <PrefRow
          label={trial.plan === "owner" ? "Owner" : "Paid"}
          value="unlimited"
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          <PrefRow
            label="Free trial"
            value={
              trial.blocked
                ? "ended"
                : `${trial.days_left ?? 0} day${(trial.days_left ?? 0) === 1 ? "" : "s"} left`
            }
          />
          <PrefRow
            label="Photo analyses"
            value={`${trial.analyses_used} / ${trial.analyses_limit ?? 0}`}
          />
          <div className="rounded-[18px] border border-dashed border-line-dashed px-4 py-3.5">
            <div className="text-[13.5px] font-bold">
              {trial.blocked ? "Trial ended" : "After the trial"}
            </div>
            <div className={NOTE}>
              Photo logging pauses; everything else keeps working. Email{" "}
              {trial.contact_email} to switch to a paid account.
            </div>
            <a
              href={`mailto:${trial.contact_email}?subject=${encodeURIComponent("MacroTrack — upgrade to a paid account")}`}
              className="mt-2.5 inline-block text-[13.5px] font-bold text-accent"
            >
              Email {trial.contact_email}
            </a>
          </div>
        </div>
      )}

      {/* --------------------------------------------------- preferences */}

      <SectionTitle className="mx-0.5 mt-[22px] mb-2.5">Preferences</SectionTitle>

      <div className="flex flex-col gap-2.5">
        <div className={ROW}>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="timezone" className="flex-none font-bold">
              Time zone
            </label>
            {/* The caret is a sibling: a <select> may only contain options. */}
            <span className="flex min-w-0 items-center gap-1.5">
              <select
                id="timezone"
                value={zone}
                disabled={pendingZone !== null}
                onChange={(e) => void pickZone(e.target.value)}
                className="tnum min-w-0 truncate appearance-none border-0 bg-transparent p-0 text-right font-mono text-[13.5px] text-muted outline-none disabled:text-disabled"
              >
                {zoneOptions.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
              <svg
                viewBox="0 0 10 6"
                aria-hidden="true"
                className="h-[6px] w-[10px] flex-none text-faint"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M1 1l4 4 4-4" />
              </svg>
            </span>
          </div>
          <div className={NOTE}>
            Days are cut at midnight in this zone. Meals already logged keep the
            day they were filed under.
          </div>
          {deviceZone !== zone && (
            <button
              type="button"
              onClick={() => void pickZone(deviceZone)}
              disabled={pendingZone !== null}
              className="mt-2 block text-left text-[13.5px] font-bold text-accent disabled:text-disabled"
            >
              Use this device&rsquo;s zone ·{" "}
              <span className="font-mono">{deviceZone}</span>
            </button>
          )}
        </div>

        <PrefRow label="Units" value={`${profile.weight_unit} · kcal`} />

        <div className={ROW}>
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold">History kept</span>
            <span className="tnum font-mono text-muted">
              {RETENTION_DAYS} days
            </span>
          </div>
          <div className={NOTE}>
            Days older than {RETENTION_DAYS} are deleted automatically, photos
            included. Export a month before it rolls off if you want to keep it.
          </div>
        </div>

        <div className="rounded-[18px] border border-dashed border-line-strong px-4 py-3.5">
          <div className="text-[13.5px] font-bold">Add to Home Screen</div>
          <div className={NOTE}>
            Runs in your mobile browser. Install it to get a full-screen window,
            the camera, and reminder notifications.
          </div>
        </div>

        <button
          type="button"
          onClick={() => setOnboard(true)}
          className="rounded-[18px] border border-dashed border-line-dashed px-4 py-3.5 text-left text-[13.5px] font-bold text-accent"
        >
          Re-run setup
        </button>
      </div>

      <button
        type="button"
        onClick={() => void signOut()}
        className="mx-auto mt-6 block px-4 py-2 text-[13px] text-muted"
      >
        Sign out
      </button>
    </div>
  );
}
