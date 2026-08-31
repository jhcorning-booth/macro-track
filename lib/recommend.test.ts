import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { recommend, bmrOf, ageFromBirthYear, type BodyInputs } from "./recommend";
import {
  cmToFeetInches, feetInchesToCm, formatHeight, formatWeight,
  formatWeightDelta, weightToKg, weightIn,
} from "./units";

/* The recommendation is the one place this app tells someone a number about
   their body. The floors and clamps are the point, so they are what's tested. */

const base: BodyInputs = {
  sex: "male", age: 30, heightCm: 178, weightKg: 63.5, // 140 lb
  goalWeightKg: 72.6, activity: "light",               // 160 lb
};

describe("BMR", () => {
  test("Mifflin-St Jeor, worked by hand", () => {
    // 10(63.5) + 6.25(178) - 5(30) + 5 = 635 + 1112.5 - 150 + 5
    assert.equal(Math.round(bmrOf({ sex: "male", age: 30, heightCm: 178, weightKg: 63.5 })), 1603);
  });
  test("female coefficient is 166 lower than male", () => {
    const a = bmrOf({ sex: "male", age: 30, heightCm: 178, weightKg: 63.5 });
    const b = bmrOf({ sex: "female", age: 30, heightCm: 178, weightKg: 63.5 });
    assert.equal(Math.round(a - b), 166);
  });
  test("unspecified sits exactly between the two", () => {
    const m = bmrOf({ sex: "male", age: 30, heightCm: 178, weightKg: 63.5 });
    const f = bmrOf({ sex: "female", age: 30, heightCm: 178, weightKg: 63.5 });
    const u = bmrOf({ sex: "unspecified", age: 30, heightCm: 178, weightKg: 63.5 });
    assert.equal(Math.round(u), Math.round((m + f) / 2));
  });
});

describe("direction", () => {
  test("gaining reads as a lean bulk and lands above maintenance", () => {
    const r = recommend(base);
    assert.equal(r.direction, "gain");
    assert.equal(r.goalLabel, "lean bulk");
    assert.ok(r.calories > r.tdee, "a surplus must exceed TDEE");
  });
  test("losing reads as cutting and lands below maintenance", () => {
    const r = recommend({ ...base, goalWeightKg: 57 });
    assert.equal(r.direction, "lose");
    assert.equal(r.goalLabel, "cutting");
    assert.ok(r.calories < r.tdee);
  });
  test("a goal within half a kilo is maintenance, not a rounding error", () => {
    const r = recommend({ ...base, goalWeightKg: 63.7 });
    assert.equal(r.direction, "maintain");
    assert.equal(r.weeksToGoal, null);
    assert.equal(r.calories, Math.round(r.tdee / 10) * 10);
  });
});

describe("safety floors — the part that must not be defeatable by input", () => {
  test("an absurd goal weight cannot push the target below the floor", () => {
    const r = recommend({ ...base, weightKg: 50, goalWeightKg: 30, activity: "sedentary" });
    assert.ok(r.calories >= 1500, `male floor is 1500, got ${r.calories}`);
    assert.ok(r.notes.some((n) => /Held at/.test(n)), "the clamp must be explained");
  });
  test("never below the person's own BMR", () => {
    const r = recommend({
      sex: "male", age: 25, heightCm: 195, weightKg: 120,
      goalWeightKg: 70, activity: "sedentary",
    });
    assert.ok(r.calories >= r.bmr, `${r.calories} < BMR ${r.bmr}`);
  });
  test("loss pace is capped at 1% of body weight per week", () => {
    const r = recommend({ ...base, weightKg: 40, goalWeightKg: 30 });
    assert.ok(Math.abs(r.paceKgPerWeek) <= 40 * 0.01 + 1e-9);
  });
  test("an out-of-range goal is flagged rather than silently pursued", () => {
    const r = recommend({ ...base, goalWeightKg: 35 });
    assert.ok(r.notes.some((n) => /outside the usual range/.test(n)));
  });
  test("ages outside 18-80 are flagged", () => {
    assert.ok(recommend({ ...base, age: 15 }).notes.some((n) => /18–80/.test(n)));
    assert.ok(recommend({ ...base, age: 88 }).notes.some((n) => /18–80/.test(n)));
    assert.equal(recommend({ ...base, age: 40 }).notes.some((n) => /18–80/.test(n)), false);
  });
});

describe("macros", () => {
  test("the four numbers are self-consistent", () => {
    const r = recommend(base);
    const fromMacros = r.protein_g * 4 + r.carbs_g * 4 + r.fat_g * 9;
    assert.ok(Math.abs(fromMacros - r.calories) <= 25, `${fromMacros} vs ${r.calories}`);
  });
  test("protein never exceeds 40% of calories", () => {
    const r = recommend({ ...base, weightKg: 150, goalWeightKg: 150, activity: "sedentary" });
    assert.ok((r.protein_g * 4) / r.calories <= 0.401);
  });
  test("carbs never go negative", () => {
    const r = recommend({ ...base, weightKg: 140, goalWeightKg: 90, activity: "sedentary" });
    assert.ok(r.carbs_g >= 0);
  });
  test("everything is rounded to something a person would actually type", () => {
    const r = recommend(base);
    assert.equal(r.calories % 10, 0);
    for (const g of [r.protein_g, r.carbs_g, r.fat_g]) assert.equal(g % 5, 0);
  });
});

describe("pace and projection", () => {
  test("weeks-to-goal follows from the pace", () => {
    const r = recommend(base);
    const expected = Math.ceil((72.6 - 63.5) / r.paceKgPerWeek);
    assert.equal(r.weeksToGoal, expected);
  });
  test("gaining is capped tighter than losing", () => {
    const gain = recommend({ ...base, goalWeightKg: 90 });
    const lose = recommend({ ...base, goalWeightKg: 50 });
    assert.ok(Math.abs(gain.paceKgPerWeek) < Math.abs(lose.paceKgPerWeek));
  });
  test("more activity means more food for the same goal", () => {
    const a = recommend({ ...base, activity: "sedentary" });
    const b = recommend({ ...base, activity: "very_active" });
    assert.ok(b.calories > a.calories + 400);
  });
});

describe("units", () => {
  test("a pound round-trips through kilograms", () => {
    assert.ok(Math.abs(weightIn(weightToKg(140, "lb"), "lb") - 140) < 1e-9);
  });
  test("140 lb displays as 63.5 kg, never as 140 kg", () => {
    const kg = weightToKg(140, "lb");
    assert.equal(formatWeight(kg, "kg"), "63.5 kg");
    assert.equal(formatWeight(kg, "lb"), "140.0 lb");
  });
  test("feet and inches never render as 5 ft 12 in", () => {
    for (let cm = 120; cm <= 220; cm += 0.5) {
      const { inches } = cmToFeetInches(cm);
      assert.ok(inches >= 0 && inches <= 11, `${cm}cm -> ${inches}in`);
    }
  });
  test("height round-trips to the nearest inch", () => {
    const { feet, inches } = cmToFeetInches(178);
    assert.equal(`${feet}'${inches}`, "5'10");
    assert.ok(Math.abs(feetInchesToCm(feet, inches) - 178) < 1.3);
  });
  test("missing values render as an em dash, not NaN", () => {
    assert.equal(formatWeight(null, "lb"), "—");
    assert.equal(formatHeight(null, "cm"), "—");
    assert.equal(formatWeightDelta(null, "kg"), "—");
  });
  test("deltas carry their sign and unit", () => {
    assert.equal(formatWeightDelta(weightToKg(0.4, "lb"), "lb"), "+0.4 lb");
    assert.equal(formatWeightDelta(weightToKg(-0.4, "lb"), "lb"), "−0.4 lb");
  });
});

describe("age", () => {
  test("derived from the birth year at read time", () => {
    assert.equal(ageFromBirthYear(1996, new Date("2026-08-30T00:00:00Z")), 30);
    assert.equal(ageFromBirthYear(1996, new Date("2027-01-01T00:00:00Z")), 31);
  });
});
