/** Unit conversion and display. Storage is canonical metric — kilograms and
 *  centimetres — and the user's preference is applied only at the edges. The
 *  alternative (storing whatever unit was active) makes every stored number
 *  ambiguous the moment someone switches. */

export type WeightUnit = "lb" | "kg";
export type HeightUnit = "cm" | "ft_in";

const LB_PER_KG = 2.2046226218;
const CM_PER_IN = 2.54;

export const kgToLb = (kg: number) => kg * LB_PER_KG;
export const lbToKg = (lb: number) => lb / LB_PER_KG;
export const cmToIn = (cm: number) => cm / CM_PER_IN;
export const inToCm = (inches: number) => inches * CM_PER_IN;

/** A stored kilogram value in whatever unit the user reads in. */
export function weightIn(kg: number, unit: WeightUnit): number {
  return unit === "kg" ? kg : kgToLb(kg);
}

/** The inverse: what the user typed, back to canonical kilograms. */
export function weightToKg(value: number, unit: WeightUnit): number {
  return unit === "kg" ? value : lbToKg(value);
}

/** "140.2 lb" / "63.6 kg" — one decimal, which is the resolution of a
 *  bathroom scale and of the design's weight card. */
export function formatWeight(kg: number | null, unit: WeightUnit): string {
  if (kg === null || !Number.isFinite(kg)) return "—";
  return `${weightIn(kg, unit).toFixed(1)} ${unit}`;
}

/** Signed delta, for weight change. The unit matters: 0.4 lb and 0.4 kg are
 *  very different claims. */
export function formatWeightDelta(kg: number | null, unit: WeightUnit): string {
  if (kg === null || !Number.isFinite(kg)) return "—";
  const v = weightIn(kg, unit);
  const rounded = Number(v.toFixed(1));
  return `${rounded >= 0 ? "+" : "−"}${Math.abs(rounded).toFixed(1)} ${unit}`;
}

export interface FeetInches {
  feet: number;
  inches: number;
}

/** 180 cm -> 5 ft 11 in. Rounds to the nearest inch and carries 12 in up to a
 *  foot, so 5 ft 12 in can never be displayed. */
export function cmToFeetInches(cm: number): FeetInches {
  const totalInches = Math.round(cmToIn(cm));
  return { feet: Math.floor(totalInches / 12), inches: totalInches % 12 };
}

export function feetInchesToCm(feet: number, inches: number): number {
  return inToCm(feet * 12 + inches);
}

export function formatHeight(cm: number | null, unit: HeightUnit): string {
  if (cm === null || !Number.isFinite(cm)) return "—";
  if (unit === "cm") return `${Math.round(cm)} cm`;
  const { feet, inches } = cmToFeetInches(cm);
  return `${feet}′ ${inches}″`;
}

/** Step sizes that feel right in each unit: a pound is a finer increment than
 *  a kilogram, so stepping by 0.2 in both would make kg tedious. */
export function weightStep(unit: WeightUnit): number {
  return unit === "kg" ? 0.1 : 0.2;
}
