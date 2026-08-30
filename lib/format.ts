/** Number formatting. Matches the prototype exactly: whole calories with a
 *  thousands separator, grams to one decimal, trailing ".0" dropped. */

export function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 3.5 -> "3.5 g", 42 -> "42 g". Kept for the spaced form the hero macro rows
 *  use; the entry list deliberately does not (see macroLine). */
export function g(n: number): string {
  return `${trim(n)} g`;
}

/** 3.5 -> "3.5", 42.0 -> "42" */
export function trim(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function lb(n: number): string {
  return n.toFixed(1);
}

/** "+1.4" / "-0.6" / "+0.0" — always signed, for weight deltas. */
export function signed(n: number, digits = 1): string {
  const v = Number(n.toFixed(digits));
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;
}

/** "42g P · 9g C · 3.5g F" — the unit rides tight against its number here.
 *  The handoff writes it spaced ("42 g P"), but at 11px JetBrains Mono every
 *  space costs a full character width, and three of them per line made the row
 *  read as gappy against the name above it. The spaced form is kept where it
 *  has room to breathe: the hero's macro rows. */
export function macroLine(p: number, c: number, f: number): string {
  return `${trim(p)}g P · ${trim(c)}g C · ${trim(f)}g F`;
}

/** "230 kcal · 42P 9C 3.5F" — the compact form used on quick-add and toasts. */
export function compactLine(
  cal: number,
  p: number,
  c: number,
  f: number,
): string {
  return `${fmt(cal)} kcal · ${trim(p)}P ${trim(c)}C ${trim(f)}F`;
}

/** "7:10 AM" in the user's timezone. */
export function timeLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}
