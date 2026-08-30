"use client";

import { useApp, type Screen } from "@/components/store";
import {
  IconHistory,
  IconSettings,
  IconShutter,
  IconToday,
  IconTrends,
} from "@/components/icons";

const TABS: { key: Screen; label: string; Icon: typeof IconToday }[] = [
  { key: "today", label: "Today", Icon: IconToday },
  { key: "history", label: "History", Icon: IconHistory },
  { key: "trends", label: "Trends", Icon: IconTrends },
  { key: "settings", label: "Settings", Icon: IconSettings },
];

export function TabBar() {
  const { screen, setScreen } = useApp();

  // Weight lives one tap off Today, so it keeps Today lit.
  const active = screen === "weight" ? "today" : screen;

  const tab = (key: Screen, label: string, Icon: typeof IconToday) => (
    <button
      key={key}
      type="button"
      onClick={() => setScreen(key)}
      aria-current={active === key ? "page" : undefined}
      className="flex flex-col items-center gap-1 text-[10px] font-bold"
      style={{ color: active === key ? "var(--color-accent)" : "var(--color-muted)" }}
    >
      <Icon size={17} />
      {label}
    </button>
  );

  return (
    <nav
      className="grid h-[76px] flex-none grid-cols-5 items-center border-t border-line-soft bg-raised-soft px-2 pb-1.5"
      style={{ paddingBottom: "max(6px, env(safe-area-inset-bottom))", height: "calc(76px + env(safe-area-inset-bottom))" }}
      aria-label="Primary"
    >
      {tab(TABS[0].key, TABS[0].label, TABS[0].Icon)}
      {tab(TABS[1].key, TABS[1].label, TABS[1].Icon)}

      <button
        type="button"
        onClick={() => setScreen("add")}
        aria-label="Add food"
        className="flex items-center justify-center"
      >
        <span className="flex h-[58px] w-[58px] items-center justify-center rounded-full bg-accent text-[oklch(0.99_0.01_85)] shadow-fab">
          <IconShutter size={24} />
        </span>
      </button>

      {tab(TABS[2].key, TABS[2].label, TABS[2].Icon)}
      {tab(TABS[3].key, TABS[3].label, TABS[3].Icon)}
    </nav>
  );
}
