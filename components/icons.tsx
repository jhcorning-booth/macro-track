/** One coherent icon set replacing the prototype's Unicode placeholders.
 *  All 24×24, 1.7 stroke, round caps/joins — sized by the caller via `size`. */

type P = { size?: number; className?: string; strokeWidth?: number };

function Svg({
  size = 20,
  className,
  strokeWidth = 1.7,
  children,
}: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Today — a tank filling up, the app's own metaphor. */
export function IconToday(p: P) {
  return (
    <Svg {...p}>
      <rect x="5" y="3" width="14" height="18" rx="4.5" />
      <path d="M5 13.5h14" />
      <path d="M5 13.5v3A4.5 4.5 0 0 0 9.5 21h5a4.5 4.5 0 0 0 4.5-4.5v-3" fill="currentColor" stroke="none" opacity="0.9" />
    </Svg>
  );
}

export function IconHistory(p: P) {
  return (
    <Svg {...p}>
      <rect x="3" y="5" width="18" height="16" rx="4" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <path d="M8.5 14.5h2M13.5 14.5h2M8.5 17.5h2M13.5 17.5h2" />
    </Svg>
  );
}

export function IconTrends(p: P) {
  return (
    <Svg {...p}>
      <path d="M3 20V5" />
      <path d="M3 20h18" />
      <path d="M7 16.5l4-5 3.5 3L20 7" />
      <circle cx="20" cy="7" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconSettings(p: P) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3" />
    </Svg>
  );
}

/** Center FAB — an aperture. */
export function IconShutter(p: P) {
  return (
    <Svg {...p} strokeWidth={p.strokeWidth ?? 1.9}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </Svg>
  );
}

export function IconCamera(p: P) {
  return (
    <Svg {...p}>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.2-2h6.6l1.2 2h1.8A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
      <circle cx="12" cy="13" r="3.6" />
    </Svg>
  );
}

export function IconMic(p: P) {
  return (
    <Svg {...p}>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5" />
    </Svg>
  );
}

export function IconImage(p: P) {
  return (
    <Svg {...p}>
      <rect x="3" y="4.5" width="18" height="15" rx="3.5" />
      <circle cx="8.5" cy="10" r="1.6" />
      <path d="M3.5 17l4.6-4.4a2 2 0 0 1 2.7-.05L16 17M14.2 14.6l1.6-1.5a2 2 0 0 1 2.7 0l2 1.9" />
    </Svg>
  );
}

export function IconKeyboard(p: P) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="6" width="19" height="12" rx="3" />
      <path d="M6.5 9.8h.01M10 9.8h.01M13.5 9.8h.01M17 9.8h.01M6.5 12.8h.01M17 12.8h.01M9 15.5h6" />
    </Svg>
  );
}

export function IconSearch(p: P) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L21 21" />
    </Svg>
  );
}

export function IconFlash(p: P) {
  return (
    <Svg {...p}>
      <path d="M13.5 2.5L5 13.2h5.6L10 21.5 19 10.6h-5.7z" />
    </Svg>
  );
}

export function IconClose(p: P) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function IconCheck(p: P) {
  return (
    <Svg {...p} strokeWidth={p.strokeWidth ?? 2.4}>
      <path d="M4.5 12.5l5 5 10-11" />
    </Svg>
  );
}

export function IconChevronLeft(p: P) {
  return (
    <Svg {...p}>
      <path d="M14.5 5l-7 7 7 7" />
    </Svg>
  );
}

export function IconChevronRight(p: P) {
  return (
    <Svg {...p}>
      <path d="M9.5 5l7 7-7 7" />
    </Svg>
  );
}

export function IconChevronDown(p: P) {
  return (
    <Svg {...p}>
      <path d="M5.5 9l6.5 6.5L18.5 9" />
    </Svg>
  );
}

export function IconMinus(p: P) {
  return (
    <Svg {...p} strokeWidth={p.strokeWidth ?? 2}>
      <path d="M5.5 12h13" />
    </Svg>
  );
}

export function IconPlus(p: P) {
  return (
    <Svg {...p} strokeWidth={p.strokeWidth ?? 2}>
      <path d="M12 5.5v13M5.5 12h13" />
    </Svg>
  );
}

export function IconRetry(p: P) {
  return (
    <Svg {...p}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20.5 3.5V9h-5.5" />
    </Svg>
  );
}
