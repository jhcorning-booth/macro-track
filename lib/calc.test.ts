import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  applyServing,
  calorieBars,
  correlation,
  heroState,
  macroRows,
  rollingWeight,
  scaleEntry,
  sumEntries,
  targetLinePct,
  weightSummary,
  windowStats,
} from "./calc";
import { addDays, daysBetween, localDate, retentionFloor, zonedToUtc } from "./dates";
import type { AnalyzedItem, DailyLog, WeightEntry } from "./types";

/* Every number the product shows comes from these functions. The PRD's whole
   reliability argument is that the app, not the model, does the arithmetic —
   so this is where that claim gets checked. */

const TODAY = "2026-08-30";

function log(date: string, cal: number, target = 2850, extra: Partial<DailyLog> = {}): DailyLog {
  return {
    user_id: "u",
    local_date: date,
    total_calories: cal,
    total_protein_g: 150,
    total_carbs_g: 200,
    total_fat_g: 70,
    entry_count: cal > 0 ? 3 : 0,
    calories_target: target,
    protein_target_g: 200,
    carbs_target_g: 300,
    fat_target_g: 80,
    calorie_goal_achieved: cal >= target,
    weight: null,
    weight_unit: null,
    ...extra,
  };
}

function weight(date: string, w: number): WeightEntry {
  return {
    id: date,
    user_id: "u",
    local_date: date,
    weight: w,
    unit: "lb",
    notes: null,
    created_at: `${date}T12:00:00Z`,
  };
}

describe("totals", () => {
  test("sums the consumed values, coercing PostgREST numeric strings", () => {
    const totals = sumEntries([
      { calories: 230, protein_g: 42, carbs_g: 9, fat_g: 3.5 },
      // numeric() columns can arrive as strings
      { calories: "140", protein_g: "20", carbs_g: "9", fat_g: "3" },
    ] as unknown as Parameters<typeof sumEntries>[0]);
    assert.equal(totals.cal, 370);
    assert.equal(totals.p, 62);
    assert.equal(totals.f, 6.5);
  });

  test("an empty day is zero, not NaN", () => {
    assert.deepEqual(sumEntries([]), { cal: 0, p: 0, c: 0, f: 0 });
  });
});

describe("hero state", () => {
  test("below target reads as calories left to fill", () => {
    const h = heroState(1930, 2850);
    assert.equal(h.hit, false);
    assert.equal(h.statusLine, "920 kcal left to fill");
    assert.equal(h.greeting, "Let's fill up");
    assert.equal(Math.round(h.fillPct), 68);
  });

  test("at target is success, and surplus is a bonus not a penalty", () => {
    const h = heroState(2910, 2850);
    assert.equal(h.hit, true);
    assert.equal(h.statusLine, "Goal reached · +60 kcal bonus");
    assert.equal(h.greeting, "Tank's full");
  });

  test("exactly on target counts as reached", () => {
    assert.equal(heroState(2850, 2850).hit, true);
  });

  test("the gauge never overflows its track", () => {
    assert.equal(heroState(9999, 2850).fillPct, 100);
  });

  test("a zero target cannot produce NaN or a false win", () => {
    const h = heroState(0, 0);
    assert.equal(h.hit, false);
    assert.ok(Number.isFinite(h.fillPct));
  });
});

describe("macro rows", () => {
  const targets = {
    calories_target: 2850,
    protein_target_g: 200,
    carbs_target_g: 300,
    fat_target_g: 80,
  };

  test("bars cap at 100% while the text still shows the overage", () => {
    const [p, , f] = macroRows({ cal: 0, p: 199, c: 79, f: 93.5 }, targets);
    assert.equal(p.text, "199 g / 200 g");
    assert.equal(f.text, "93.5 g / 80 g");
    assert.equal(f.pct, 100);
    assert.equal(f.hit, true);
  });

  test("a macro at or over target turns green", () => {
    const [p] = macroRows({ cal: 0, p: 200, c: 0, f: 0 }, targets);
    assert.equal(p.colorVar, "var(--color-good)");
  });

  test("a zero target does not divide by zero", () => {
    const rows = macroRows({ cal: 0, p: 10, c: 0, f: 0 }, { ...targets, protein_target_g: 0 });
    assert.equal(rows[0].pct, 0);
    assert.ok(!rows[0].text.includes("NaN"));
  });
});

describe("serving math — the PRD §10 worked example", () => {
  test('label of 4 scoops, "I had two scoops", halved by the app not the model', () => {
    const item: AnalyzedItem = {
      name: "Vegan Naked Mass",
      quantity: 2,
      unit: "scoops",
      // Deliberately wrong: the model must not be trusted to multiply.
      calories: 99999,
      protein_g: 99999,
      carbs_g: 99999,
      fat_g: 99999,
      source: "nutrition_label",
      confidence: "high",
      source_label: "Nutrition label + your note",
      reasoning: "…",
      serving: {
        label_calories: 1290,
        label_protein_g: 50,
        label_carbs_g: 256,
        label_fat_g: 9,
        servings_consumed: 0.5,
      },
      barcode: null,
    };
    const out = applyServing(item);
    assert.equal(out.calories, 645);
    assert.equal(out.protein_g, 25);
    assert.equal(out.carbs_g, 128);
    assert.equal(out.fat_g, 4.5);
  });

  test('"I ate about 70%" scales proportionally', () => {
    const out = applyServing({
      serving: {
        label_calories: 500,
        label_protein_g: 20,
        label_carbs_g: 60,
        label_fat_g: 18,
        servings_consumed: 0.7,
      },
    } as AnalyzedItem);
    assert.equal(out.calories, 350);
    assert.equal(out.fat_g, 12.6);
  });

  test("no label means the model's own estimate is left alone", () => {
    const item = { calories: 670, serving: null } as AnalyzedItem;
    assert.equal(applyServing(item).calories, 670);
  });

  test("a nonsense servings_consumed is ignored rather than zeroing the entry", () => {
    const item = {
      calories: 400,
      serving: {
        label_calories: 500,
        label_protein_g: 1,
        label_carbs_g: 1,
        label_fat_g: 1,
        servings_consumed: Number.NaN,
      },
    } as AnalyzedItem;
    assert.equal(applyServing(item).calories, 400);
  });
});

describe("edit-sheet quantity multiplier", () => {
  test("scales all four nutrients and the descriptive quantity together", () => {
    const out = scaleEntry({ cal: 645, p: 25, c: 128, f: 4.5, quantity: 2 }, 1.5);
    assert.equal(out.calories, 967.5);
    assert.equal(out.protein_g, 37.5);
    assert.equal(out.carbs_g, 192);
    assert.equal(out.fat_g, 6.8); // 6.75 rounds to one decimal
    assert.equal(out.quantity, 3);
  });
});

describe("window stats", () => {
  const logs = [
    log(addDays(TODAY, -6), 2610),
    log(addDays(TODAY, -5), 2905),
    log(addDays(TODAY, -4), 2440),
    log(addDays(TODAY, -3), 2870),
    log(addDays(TODAY, -2), 3010),
    log(addDays(TODAY, -1), 2320),
    log(TODAY, 2900),
  ];

  test("averages only over days that were actually logged", () => {
    const withGap = [...logs, log(addDays(TODAY, -8), 0, 2850, { entry_count: 0 })];
    const s = windowStats(withGap, [], TODAY, 7);
    assert.equal(s.daysLogged, 7);
    assert.equal(Math.round(s.avgCalories), 2722);
  });

  test("an unlogged day is not a day at target", () => {
    const s = windowStats(logs.slice(0, 5), [], TODAY, 7);
    assert.equal(s.days, 7);
    // 3 of the 5 present days are at/above 2850, measured against all 7
    assert.equal(s.daysAtTarget, 3);
    assert.equal(Math.round(s.adherencePct), 43);
  });

  test("no data at all yields zeros, never NaN", () => {
    const s = windowStats([], [], TODAY, 30);
    assert.equal(s.avgCalories, 0);
    assert.equal(s.adherencePct, 0);
    assert.equal(s.weightChange, null);
    assert.ok(Number.isFinite(s.avgProtein));
  });

  test("days outside the window are excluded", () => {
    const old = [log(addDays(TODAY, -40), 5000)];
    assert.equal(windowStats([...logs, ...old], [], TODAY, 7).daysLogged, 7);
  });
});

describe("calorie bars and the target rule", () => {
  test("the rule is positioned from the target the header names", () => {
    const bars = calorieBars([log(TODAY, 2900)], TODAY, 7, 2850);
    const pct = targetLinePct(bars, 2850);
    // Same ceiling for both, so a bar above the target renders above the line.
    const todayBar = bars[bars.length - 1];
    assert.ok(todayBar.heightPct > pct, "an over-target bar must clear the rule");
  });

  test("a below-target bar sits under the rule", () => {
    const bars = calorieBars([log(TODAY, 2400)], TODAY, 7, 2850);
    assert.ok(bars[bars.length - 1].heightPct < targetLinePct(bars, 2850));
  });

  test("bar colour uses that day's own historical target, not today's", () => {
    // 2,600 kcal beat the old 2,500 target even though today's is 2,850.
    const bars = calorieBars([log(addDays(TODAY, -3), 2600, 2500)], TODAY, 7, 2850);
    const bar = bars.find((b) => b.date === addDays(TODAY, -3));
    assert.equal(bar?.atTarget, true);
  });

  test("an empty window produces finite heights", () => {
    for (const b of calorieBars([], TODAY, 30, 2850)) {
      assert.ok(Number.isFinite(b.heightPct));
      assert.equal(b.atTarget, false);
    }
  });
});

describe("weight", () => {
  const series = Array.from({ length: 14 }, (_, i) =>
    weight(addDays(TODAY, -13 + i), 139 + i * 0.1),
  );

  test("the moving average smooths the daily noise", () => {
    const noisy = [weight("2026-08-28", 141.5), weight("2026-08-29", 138.5), weight("2026-08-30", 140)];
    const pts = rollingWeight(noisy, 7);
    assert.equal(pts[2].raw, 140);
    assert.equal(pts[2].avg, 140); // mean of the three
  });

  test("summary reports current, 7-day and 30-day averages", () => {
    const s = weightSummary(series, TODAY);
    assert.equal(s.current, 140.3);
    assert.ok(s.avg7 !== null && s.avg7 > 139.9 && s.avg7 < 140.1);
  });

  test("no weights logged yields nulls, not zeros", () => {
    assert.deepEqual(weightSummary([], TODAY), {
      current: null,
      avg7: null,
      avg30: null,
      weeklyChange: null,
    });
  });

  test("a single weight cannot fabricate a trend", () => {
    const s = weightSummary([weight(TODAY, 140)], TODAY);
    assert.equal(s.current, 140);
    assert.equal(s.weeklyChange, null);
  });
});

describe("correlation copy", () => {
  test("stays unavailable until there is enough data to say anything", () => {
    const c = correlation([log(TODAY, 2900)], [weight(TODAY, 140)], TODAY);
    assert.equal(c.available, false);
    assert.equal(c.headline, "Pattern, not proof");
  });

  test("describes the relationship without ever claiming causation", () => {
    const logs = Array.from({ length: 28 }, (_, i) =>
      log(addDays(TODAY, -27 + i), i < 14 ? 2430 : 2810),
    );
    const weights = Array.from({ length: 28 }, (_, i) =>
      weight(addDays(TODAY, -27 + i), 139 + i * 0.08),
    );
    const c = correlation(logs, weights, TODAY);
    assert.equal(c.available, true);
    for (const banned of ["caused", "because", "due to", "makes you", "resulted in"]) {
      assert.ok(!c.body.toLowerCase().includes(banned), `causal phrasing leaked: ${banned}`);
    }
    assert.ok(c.body.includes("2,430") && c.body.includes("2,810"));
  });
});

describe("local dates", () => {
  test("the date boundary is the user's midnight, not UTC's", () => {
    // 04:30 UTC on the 31st is still the 30th in Chicago.
    const at = new Date("2026-08-31T04:30:00Z");
    assert.equal(localDate("America/Chicago", at), "2026-08-30");
    assert.equal(localDate("UTC", at), "2026-08-31");
  });

  test("retention floor spans exactly 90 days inclusive", () => {
    const floor = retentionFloor(TODAY);
    assert.equal(daysBetween(floor, TODAY), 89);
  });

  test("date arithmetic does not drift across a DST boundary", () => {
    assert.equal(addDays("2026-03-07", 3), "2026-03-10");
    assert.equal(addDays("2026-11-01", -1), "2026-10-31");
  });

  test("a wall-clock time round-trips through the user's zone", () => {
    const utc = zonedToUtc("2026-08-30", "23:30", "America/Chicago");
    assert.equal(localDate("America/Chicago", utc), "2026-08-30");
    assert.equal(utc.toISOString(), "2026-08-31T04:30:00.000Z");
  });
});
