"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Bootstrap } from "@/lib/data";
import type {
  AnalyzeStage,
  DailyLog,
  FoodEntry,
  NudgeKind,
  NudgePref,
  SavedFood,
  Targets,
  WeightEntry,
} from "@/lib/types";
import { compactLine, fmt } from "@/lib/format";
import {
  addDays,
  localDate,
  retentionFloor,
  zonedTimeValue,
  zonedToUtc,
} from "@/lib/dates";
import { sumEntries } from "@/lib/calc";
import { clearPushSubscription } from "@/lib/push";

export type Screen = "today" | "add" | "history" | "trends" | "settings" | "weight";

export interface Toast {
  id: string;
  title: string;
  line: string;
  /** Every entry this toast covers. Undo removes all of them — a multi-item
   *  log described as "3 items" must undo as three. */
  entryIds?: string[];
  photo?: string | null;
  /** A failed run keeps its evidence, and the date it was meant for, so Try
   *  again needs no re-shoot and cannot silently re-file the meal. */
  retry?: { evidenceIds: string[]; localDate: string };
}

export interface EditTarget {
  entry: FoodEntry;
  draft: {
    name: string;
    cal: number;
    p: number;
    c: number;
    f: number;
    /** Multiplier, not an absolute amount — starts at 1 every time. */
    qty: number;
    /** Local calendar date the entry belongs to (PRD §20, §21). */
    date: string;
    /** Wall-clock time in the profile's timezone, "HH:MM". */
    time: string;
    notes: string;
  };
}

const TOAST_MS = 5200;
const DAY_CHECK_MS = 60_000;

interface AppValue extends Omit<Bootstrap, "today" | "floor"> {
  /** The live local date. Recomputed as the clock crosses midnight in the
   *  user's timezone — an installed PWA can sit open across the boundary. */
  today: string;
  floor: string;

  screen: Screen;
  setScreen: (s: Screen) => void;
  onboard: boolean;
  setOnboard: (v: boolean) => void;

  processing: { active: boolean; stage: AnalyzeStage | null; preview: string | null };
  toast: Toast | null;
  dismissToast: () => void;
  editing: EditTarget | null;
  openEdit: (entry: FoodEntry) => void;
  closeEdit: () => void;
  setDraft: (patch: Partial<EditTarget["draft"]>) => void;
  celebrate: boolean;
  closeCelebrate: () => void;

  todayTotals: ReturnType<typeof sumEntries>;

  quickAdd: (food: SavedFood) => Promise<void>;
  reAdd: (source: {
    name: string;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
  }) => Promise<void>;
  analyze: (input: {
    files: File[];
    note: string;
    transcript: string;
    dateOffset: 0 | -1;
  }) => Promise<void>;
  retryAnalysis: (evidenceIds: string[], forDate: string) => Promise<void>;
  saveEdit: () => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  deleteEntries: (ids: string[]) => Promise<void>;
  /** Moves an entry relative to ITS OWN date, not to today's. */
  moveEntry: (entry: FoodEntry, days: -1 | 1) => Promise<void>;
  saveWeight: (value: number) => Promise<boolean>;
  saveTargets: (t: Targets) => Promise<void>;
  toggleNudge: (kind: NudgeKind) => Promise<void>;
  setNudgeTime: (kind: NudgeKind, sendAt: string) => Promise<void>;
  searchFoods: (q: string) => Promise<FoodEntry[]>;
  entriesForDate: (date: string) => Promise<FoodEntry[]>;
  refreshLogs: () => Promise<void>;
  signOut: () => Promise<void>;
  lastError: string | null;
  clearError: () => void;
}

const Ctx = createContext<AppValue | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside <AppProvider>");
  return v;
}

export function AppProvider({
  initial,
  children,
}: {
  initial: Bootstrap;
  children: React.ReactNode;
}) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const userId = initial.profile.id;

  const [profile, setProfile] = useState(initial.profile);
  const [today, setToday] = useState(initial.today);
  const [floor, setFloor] = useState(initial.floor);
  const [targets, setTargets] = useState(initial.targets);
  const [entries, setEntries] = useState(initial.entries);
  const [dailyLogs, setDailyLogs] = useState(initial.dailyLogs);
  const [weights, setWeights] = useState(initial.weights);
  const [savedFoods, setSavedFoods] = useState(initial.savedFoods);
  const [nudges, setNudges] = useState(initial.nudges);

  const [screen, setScreenRaw] = useState<Screen>("today");
  const [onboard, setOnboard] = useState(!initial.profile.onboarded_at);
  const [processing, setProcessing] = useState<{
    active: boolean;
    stage: AnalyzeStage | null;
    preview: string | null;
  }>({ active: false, stage: null, preview: null });
  const [toast, setToast] = useState<Toast | null>(null);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const celebrateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside callbacks that must not be re-created on every date change.
  const todayRef = useRef(today);
  todayRef.current = today;

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (celebrateTimer.current) clearTimeout(celebrateTimer.current);
    },
    [],
  );

  const todayTotals = useMemo(() => sumEntries(entries), [entries]);

  const setScreen = useCallback((s: Screen) => {
    setScreenRaw(s);
    setEditing(null);
  }, []);

  const showToast = useCallback((t: Toast) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(
      () => setToast((cur) => (cur?.id === t.id ? null : cur)),
      TOAST_MS,
    );
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  /* ------------------------------------------------------ data loading */

  const refreshLogs = useCallback(async () => {
    const from = retentionFloor(todayRef.current);
    const [{ data: logs }, { data: w }] = await Promise.all([
      supabase
        .from("daily_logs")
        .select("*")
        .gte("local_date", from)
        .order("local_date", { ascending: true }),
      supabase
        .from("weight_entries")
        .select("*")
        .gte("local_date", from)
        .order("local_date", { ascending: true }),
    ]);
    if (logs) setDailyLogs(logs as DailyLog[]);
    if (w) setWeights(w as WeightEntry[]);
  }, [supabase]);

  const refreshSaved = useCallback(async () => {
    const { data } = await supabase
      .from("saved_foods")
      .select("*")
      .order("last_used", { ascending: false })
      .limit(8);
    if (data) setSavedFoods(data as SavedFood[]);
  }, [supabase]);

  /** Swaps the whole day over: its entries, and the target version in force on
   *  that date (which may differ from yesterday's). */
  const loadDay = useCallback(
    async (date: string) => {
      const [{ data: rows }, { data: t }] = await Promise.all([
        supabase
          .from("food_entries")
          .select("*")
          .eq("local_date", date)
          .order("consumed_at", { ascending: true }),
        supabase
          .from("nutrition_targets")
          .select("calories_target, protein_target_g, carbs_target_g, fat_target_g")
          .lte("effective_from", date)
          .or(`effective_to.is.null,effective_to.gte.${date}`)
          .order("effective_from", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      setEntries((rows ?? []) as FoodEntry[]);
      if (t) setTargets(t as Targets);
    },
    [supabase],
  );

  /* -------------------------------------------------- midnight rollover
     PRD §19: a new daily log begins at local midnight. This is an installed
     PWA that can sit open across that boundary, so the date cannot be frozen
     at bootstrap — otherwise a 12:15 AM snack files onto yesterday. */

  useEffect(() => {
    const check = () => {
      const now = localDate(profile.timezone);
      if (now === todayRef.current) return;
      todayRef.current = now;
      setToday(now);
      setFloor(retentionFloor(now));
      setCelebrate(false);
      void loadDay(now);
      void refreshLogs();
    };

    const id = setInterval(check, DAY_CHECK_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [profile.timezone, loadDay, refreshLogs]);

  /* ---------------------------------------------------------- celebrate */

  /** Fires once per day, on the transition from below-target to at/above, and
   *  suppresses the toast while it's up (design §6). */
  const maybeCelebrate = useCallback(
    (before: number, after: number) => {
      const target = Number(targets.calories_target);
      if (!(target > 0 && before < target && after >= target)) return;
      const key = `mt:celebrated:${todayRef.current}`;
      try {
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, "1");
      } catch {
        /* private mode — celebrate anyway, worst case it repeats */
      }
      if (celebrateTimer.current) clearTimeout(celebrateTimer.current);
      celebrateTimer.current = setTimeout(() => {
        setCelebrate(true);
        setToast(null);
      }, 900);
    },
    [targets.calories_target],
  );

  /* ------------------------------------------------------------ logging */

  /** Adds rows to today's in-memory list ONLY when they belong to today. An
   *  entry filed to yesterday must not move today's gauge. Returns the
   *  calories that actually landed on today. */
  const absorb = useCallback((added: FoodEntry[]) => {
    const mine = added.filter((e) => e.local_date === todayRef.current);
    if (mine.length) setEntries((cur) => [...cur, ...mine]);
    return mine.reduce((s, e) => s + Number(e.calories), 0);
  }, []);

  const insertEntry = useCallback(
    async (
      row: Partial<FoodEntry> & { name: string },
      toastTitle: string,
    ): Promise<FoodEntry | null> => {
      const before = todayTotals.cal;
      const { data, error } = await supabase
        .from("food_entries")
        .insert({
          user_id: userId,
          local_date: todayRef.current,
          consumed_at: new Date().toISOString(),
          quantity: 1,
          source_type: "manual",
          confidence: "high",
          ...row,
        })
        .select("*")
        .single();

      if (error || !data) {
        setLastError(error?.message ?? "Could not save that entry.");
        return null;
      }

      const entry = data as FoodEntry;
      const delta = absorb([entry]);
      showToast({
        id: entry.id,
        title: toastTitle,
        line: compactLine(entry.calories, entry.protein_g, entry.carbs_g, entry.fat_g),
        entryIds: [entry.id],
        photo: null,
      });
      maybeCelebrate(before, before + delta);
      void refreshLogs();
      return entry;
    },
    [supabase, userId, todayTotals.cal, absorb, showToast, maybeCelebrate, refreshLogs],
  );

  const quickAdd = useCallback(
    async (food: SavedFood) => {
      setScreen("today");
      await insertEntry(
        {
          name: food.name,
          calories: food.calories,
          protein_g: food.protein_g,
          carbs_g: food.carbs_g,
          fat_g: food.fat_g,
          unit: food.serving_size,
          source_type: "quick_add",
          confidence: "high",
          source_label: "Quick add · saved food",
          reasoning: "Added from your library — no AI inference needed.",
          saved_food_id: food.id,
        },
        `Logged · ${food.name}`,
      );
      await supabase
        .from("saved_foods")
        .update({
          times_logged: Number(food.times_logged) + 1,
          last_used: new Date().toISOString(),
        })
        .eq("id", food.id);
      void refreshSaved();
    },
    [insertEntry, setScreen, supabase, refreshSaved],
  );

  const reAdd = useCallback(
    async (source: {
      name: string;
      calories: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
    }) => {
      setScreen("today");
      await insertEntry(
        {
          ...source,
          source_type: "history_readd",
          confidence: "high",
          source_label: "History · re-added",
          reasoning: "Re-added from a past day with the values you confirmed then.",
        },
        `Logged · ${source.name}`,
      );
    },
    [insertEntry, setScreen],
  );

  /** Streams real pipeline stages so the overlay isn't a fake progress bar. */
  const runAnalysis = useCallback(
    async (body: FormData, preview: string | null, forDate: string) => {
      const before = todayTotals.cal;
      setProcessing({ active: true, stage: "reading_label", preview });
      setScreen("today");

      // Captured as soon as the server reports them, so a mid-stream network
      // drop still leaves Try again something to work with.
      let evidenceIds: string[] = [];

      try {
        const res = await fetch("/api/analyze", { method: "POST", body });
        if (res.status === 401) throw new Error("Signed out — sign in again and retry.");
        if (!res.ok || !res.body) throw new Error(await res.text());
        // A redirect to an HTML page would otherwise be parsed as an empty
        // event stream, and the capture would vanish with no toast at all.
        if (!res.headers.get("content-type")?.includes("text/event-stream")) {
          throw new Error("Unexpected response from the analyzer.");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            const evt = JSON.parse(line.slice(5).trim());

            if (evt.type === "evidence") {
              evidenceIds = evt.evidenceIds ?? [];
            } else if (evt.type === "stage") {
              setProcessing((cur) => ({ ...cur, active: true, stage: evt.stage }));
            } else if (evt.type === "logged") {
              const added = evt.entries as FoodEntry[];
              if (!added.length) continue;
              setProcessing({ active: false, stage: null, preview: null });
              const delta = absorb(added);
              const head = added[0];
              const forToday = head.local_date === todayRef.current;
              showToast({
                id: head.id,
                title:
                  added.length === 1
                    ? `Logged · ${head.name}`
                    : `Logged · ${added.length} items`,
                line:
                  (added.length === 1
                    ? compactLine(head.calories, head.protein_g, head.carbs_g, head.fat_g)
                    : `${fmt(added.reduce((s, e) => s + Number(e.calories), 0))} kcal total`) +
                  (forToday ? "" : " · yesterday"),
                entryIds: added.map((e) => e.id),
                photo: head.photo_url ?? null,
              });
              maybeCelebrate(before, before + delta);
              void refreshLogs();
              void refreshSaved();
            } else if (evt.type === "error") {
              setProcessing({ active: false, stage: null, preview: null });
              const ids: string[] = evt.evidenceIds?.length ? evt.evidenceIds : evidenceIds;
              showToast({
                id: `err-${Date.now()}`,
                title: "Couldn't read that one",
                line: evt.message ?? "Your photo is saved — try again.",
                retry: ids.length ? { evidenceIds: ids, localDate: forDate } : undefined,
              });
            }
          }
        }
      } catch (err) {
        setProcessing({ active: false, stage: null, preview: null });
        showToast({
          id: `err-${Date.now()}`,
          title: "Couldn't reach the analyzer",
          line: evidenceIds.length
            ? "Your photo is saved — try again."
            : err instanceof Error
              ? err.message
              : "Something went wrong. Try again.",
          // With no evidence ids there is nothing to retry; the toast then
          // shows no Try again button rather than a dead one.
          retry: evidenceIds.length ? { evidenceIds, localDate: forDate } : undefined,
        });
      } finally {
        setProcessing({ active: false, stage: null, preview: null });
        if (preview) URL.revokeObjectURL(preview);
      }
    },
    [todayTotals.cal, setScreen, absorb, showToast, maybeCelebrate, refreshLogs, refreshSaved],
  );

  const analyze = useCallback(
    async ({
      files,
      note,
      transcript,
      dateOffset,
    }: {
      files: File[];
      note: string;
      transcript: string;
      dateOffset: 0 | -1;
    }) => {
      const forDate = addDays(todayRef.current, dateOffset);
      const fd = new FormData();
      files.forEach((f) => fd.append("images", f));
      fd.set("note", note);
      fd.set("transcript", transcript);
      fd.set("local_date", forDate);
      const preview = files[0] ? URL.createObjectURL(files[0]) : null;
      await runAnalysis(fd, preview, forDate);
    },
    [runAnalysis],
  );

  const retryAnalysis = useCallback(
    async (evidenceIds: string[], forDate: string) => {
      if (!evidenceIds.length) return;
      const fd = new FormData();
      fd.set("retry_evidence", evidenceIds.join(","));
      // The date the capture was originally meant for, so a late-night retry
      // doesn't silently re-file yesterday's meal onto today.
      fd.set("local_date", forDate);
      await runAnalysis(fd, null, forDate);
    },
    [runAnalysis],
  );

  /* ------------------------------------------------------------ editing */

  const openEdit = useCallback(
    (entry: FoodEntry) => {
      dismissToast();
      setEditing({
        entry,
        draft: {
          name: entry.name,
          cal: Number(entry.calories),
          p: Number(entry.protein_g),
          c: Number(entry.carbs_g),
          f: Number(entry.fat_g),
          qty: 1,
          date: entry.local_date,
          time: zonedTimeValue(entry.consumed_at, profile.timezone),
          notes: entry.notes ?? "",
        },
      });
    },
    [dismissToast, profile.timezone],
  );

  const closeEdit = useCallback(() => setEditing(null), []);

  const setDraft = useCallback((patch: Partial<EditTarget["draft"]>) => {
    setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur));
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    const { entry, draft } = editing;
    const q = draft.qty || 1;
    const dateChanged = draft.date !== entry.local_date;
    const timeChanged = draft.time !== zonedTimeValue(entry.consumed_at, profile.timezone);
    const patch = {
      name: draft.name.trim() || entry.name,
      calories: Math.round(draft.cal * q * 10) / 10,
      protein_g: Math.round(draft.p * q * 10) / 10,
      carbs_g: Math.round(draft.c * q * 10) / 10,
      fat_g: Math.round(draft.f * q * 10) / 10,
      quantity: Math.round(Number(entry.quantity) * q * 100) / 100,
      notes: draft.notes.trim() || null,
      local_date: draft.date,
      ...(dateChanged || timeChanged
        ? { consumed_at: zonedToUtc(draft.date, draft.time, profile.timezone).toISOString() }
        : {}),
    };

    setEditing(null);
    const { data, error } = await supabase
      .from("food_entries")
      .update(patch)
      .eq("id", entry.id)
      .select("*")
      .single();

    if (error || !data) {
      setLastError(error?.message ?? "Could not save those changes.");
      return;
    }

    const saved = data as FoodEntry;
    setEntries((cur) => {
      const photo = cur.find((e) => e.id === saved.id)?.photo_url ?? entry.photo_url ?? null;
      const without = cur.filter((e) => e.id !== saved.id);
      // Re-dating a past entry INTO today has to ADD it to today's list, not
      // just rewrite a row that was never in it.
      if (saved.local_date !== todayRef.current) return without;
      return [...without, { ...saved, photo_url: photo }].sort((a, b) =>
        a.consumed_at.localeCompare(b.consumed_at),
      );
    });
    void refreshLogs();
  }, [editing, supabase, refreshLogs, profile.timezone]);

  const deleteEntries = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      setEditing(null);
      dismissToast();

      // Remember what was removed so a failed write can put it back.
      const removed = entries.filter((e) => ids.includes(e.id));
      setEntries((cur) => cur.filter((e) => !ids.includes(e.id)));

      const { error } = await supabase.from("food_entries").delete().in("id", ids);
      if (error) {
        setLastError(error.message);
        // The rows are still in the database; restoring them keeps the gauge
        // honest instead of hiding calories that were never actually removed.
        if (removed.length) {
          setEntries((cur) =>
            [...cur.filter((e) => !ids.includes(e.id)), ...removed].sort((a, b) =>
              a.consumed_at.localeCompare(b.consumed_at),
            ),
          );
        }
      }
      void refreshLogs();
    },
    [entries, supabase, dismissToast, refreshLogs],
  );

  const deleteEntry = useCallback(
    async (id: string) => deleteEntries([id]),
    [deleteEntries],
  );

  const moveEntry = useCallback(
    async (entry: FoodEntry, days: -1 | 1) => {
      // Relative to the entry's OWN date. An entry opened from History must
      // move to the day before itself, not the day before today.
      const to = addDays(entry.local_date, days);

      setEditing(null);
      setEntries((cur) => cur.filter((e) => e.id !== entry.id));

      const { error } = await supabase
        .from("food_entries")
        .update({ local_date: to })
        .eq("id", entry.id);

      if (error) {
        setLastError(error.message);
        void refreshLogs();
        return;
      }

      // It may have moved INTO today (moving yesterday's entry forward).
      if (to === todayRef.current) {
        setEntries((cur) =>
          [...cur.filter((e) => e.id !== entry.id), { ...entry, local_date: to }].sort((a, b) =>
            a.consumed_at.localeCompare(b.consumed_at),
          ),
        );
      }

      showToast({
        id: `move-${entry.id}`,
        title:
          to === addDays(todayRef.current, -1)
            ? "Moved to yesterday"
            : to === todayRef.current
              ? "Moved to today"
              : `Moved to ${to}`,
        line: "Both days' totals updated",
      });
      void refreshLogs();
    },
    [supabase, showToast, refreshLogs],
  );

  /* ------------------------------------------------------------- weight */

  const saveWeight = useCallback(
    async (value: number): Promise<boolean> => {
      const { data, error } = await supabase
        .from("weight_entries")
        .upsert(
          {
            user_id: userId,
            local_date: todayRef.current,
            weight: value,
            unit: profile.weight_unit,
          },
          { onConflict: "user_id,local_date" },
        )
        .select("*")
        .single();

      if (error || !data) {
        setLastError(error?.message ?? "Could not save that weight.");
        return false;
      }
      const saved = data as WeightEntry;
      setWeights((cur) =>
        [...cur.filter((w) => w.local_date !== saved.local_date), saved].sort((a, b) =>
          a.local_date.localeCompare(b.local_date),
        ),
      );
      void refreshLogs();
      return true;
    },
    [supabase, userId, profile.weight_unit, refreshLogs],
  );

  /* ------------------------------------------------------------ targets */

  const saveTargets = useCallback(
    async (t: Targets) => {
      setTargets(t);
      const { error } = await supabase.rpc("set_targets_from", {
        // The live date, not the one this session booted with — after midnight
        // a frozen value would delete yesterday's version and rescore that day.
        p_from: todayRef.current,
        p_calories: Math.round(t.calories_target),
        p_protein: t.protein_target_g,
        p_carbs: t.carbs_target_g,
        p_fat: t.fat_target_g,
      });
      if (error) {
        setLastError(error.message);
        return;
      }
      if (!profile.onboarded_at) {
        const stamp = new Date().toISOString();
        await supabase.from("profiles").update({ onboarded_at: stamp }).eq("id", userId);
        setProfile((p) => ({ ...p, onboarded_at: stamp }));
      }
      void refreshLogs();
    },
    [supabase, profile.onboarded_at, userId, refreshLogs],
  );

  /* ------------------------------------------------------------- nudges */

  const upsertNudge = useCallback(
    async (kind: NudgeKind, patch: Partial<NudgePref>) => {
      const current = nudges.find((n) => n.kind === kind);
      const next: NudgePref = {
        kind,
        enabled: current?.enabled ?? true,
        send_at: current?.send_at ?? "10:00",
        ...patch,
      };
      setNudges((cur) => [...cur.filter((n) => n.kind !== kind), next]);
      const { error } = await supabase
        .from("notification_prefs")
        .upsert({ user_id: userId, ...next }, { onConflict: "user_id,kind" });
      if (error) setLastError(error.message);
    },
    [nudges, supabase, userId],
  );

  const toggleNudge = useCallback(
    async (kind: NudgeKind) => {
      const current = nudges.find((n) => n.kind === kind);
      await upsertNudge(kind, { enabled: !(current?.enabled ?? true) });
    },
    [nudges, upsertNudge],
  );

  const setNudgeTime = useCallback(
    async (kind: NudgeKind, sendAt: string) => upsertNudge(kind, { send_at: sendAt }),
    [upsertNudge],
  );

  /* ------------------------------------------------------------ queries */

  const searchFoods = useCallback(
    async (q: string): Promise<FoodEntry[]> => {
      const term = q.trim();
      if (term.length < 2) return [];
      // % and _ are LIKE wildcards; a food called "2% milk" must not become a
      // pattern that matches half the library.
      const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const { data } = await supabase
        .from("food_entries")
        .select("*")
        .ilike("name", pattern)
        .gte("local_date", retentionFloor(todayRef.current))
        .order("consumed_at", { ascending: false })
        .limit(40);

      // Collapse repeats of the same food to its most recent confirmed values.
      const seen = new Set<string>();
      const out: FoodEntry[] = [];
      for (const row of (data ?? []) as FoodEntry[]) {
        const key = row.name.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
        if (out.length === 4) break;
      }
      return out;
    },
    [supabase],
  );

  const entriesForDate = useCallback(
    async (date: string): Promise<FoodEntry[]> => {
      const { data } = await supabase
        .from("food_entries")
        .select("*")
        .eq("local_date", date)
        .order("consumed_at", { ascending: true });
      return (data ?? []) as FoodEntry[];
    },
    [supabase],
  );

  const signOut = useCallback(async () => {
    // Drop the push subscription first, or this device keeps receiving the
    // signed-out account's nudges.
    await clearPushSubscription();
    await supabase.auth.signOut();
    router.replace("/signin");
    router.refresh();
  }, [supabase, router]);

  const value: AppValue = {
    profile,
    today,
    floor,
    targets,
    entries,
    dailyLogs,
    weights,
    savedFoods,
    nudges,

    screen,
    setScreen,
    onboard,
    setOnboard,
    processing,
    toast,
    dismissToast,
    editing,
    openEdit,
    closeEdit,
    setDraft,
    celebrate,
    closeCelebrate: () => setCelebrate(false),
    todayTotals,

    quickAdd,
    reAdd,
    analyze,
    retryAnalysis,
    saveEdit,
    deleteEntry,
    deleteEntries,
    moveEntry,
    saveWeight,
    saveTargets,
    toggleNudge,
    setNudgeTime,
    searchFoods,
    entriesForDate,
    refreshLogs,
    signOut,
    lastError,
    clearError: () => setLastError(null),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
