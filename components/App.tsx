"use client";

import { useEffect } from "react";
import { AppProvider, useApp } from "@/components/store";
import { TabBar } from "@/components/TabBar";
import {
  Celebration,
  EditSheet,
  ProcessingOverlay,
  ToastBar,
} from "@/components/overlays";
import TodayScreen from "@/components/screens/TodayScreen";
import AddScreen from "@/components/screens/AddScreen";
import HistoryScreen from "@/components/screens/HistoryScreen";
import TrendsScreen from "@/components/screens/TrendsScreen";
import SettingsScreen from "@/components/screens/SettingsScreen";
import { Onboarding, WeightScreen } from "@/components/screens/WeightAndOnboarding";
import { registerServiceWorker } from "@/lib/push";
import type { Bootstrap } from "@/lib/data";

function Shell() {
  const { screen, onboard, lastError, clearError } = useApp();

  useEffect(() => {
    void registerServiceWorker();
  }, []);

  // The dark camera surface owns the whole frame; every other screen scrolls
  // inside the shell with the tab bar pinned beneath it.
  const scrolls = screen !== "add";

  return (
    <div className="fixed inset-0 flex justify-center bg-canvas">
      <div className="relative flex h-full w-full max-w-[440px] flex-col overflow-hidden bg-surface">
        <div className="relative flex-1 overflow-hidden">
          <div
            className={
              scrolls
                ? "no-scrollbar h-full overflow-y-auto pt-[env(safe-area-inset-top)]"
                : "h-full pt-[env(safe-area-inset-top)]"
            }
          >
            {screen === "today" && <TodayScreen />}
            {screen === "add" && <AddScreen />}
            {screen === "history" && <HistoryScreen />}
            {screen === "trends" && <TrendsScreen />}
            {screen === "settings" && <SettingsScreen />}
            {screen === "weight" && <WeightScreen />}
          </div>

          {onboard && <Onboarding />}
          <ProcessingOverlay />
          <ToastBar />
          <EditSheet />
          <Celebration />

          {lastError && (
            <button
              type="button"
              onClick={clearError}
              className="absolute inset-x-3.5 bottom-24 z-[7] animate-rise-toast rounded-[22px] border border-danger-line bg-raised px-4 py-3.5 text-left shadow-toast"
            >
              <span className="block text-[13px] font-bold text-danger">
                That didn&rsquo;t save
              </span>
              <span className="mt-0.5 block font-mono text-[11px] text-muted">
                {lastError}
              </span>
            </button>
          )}
        </div>

        <TabBar />
      </div>
    </div>
  );
}

export default function App({ initial }: { initial: Bootstrap }) {
  return (
    <AppProvider initial={initial}>
      <Shell />
    </AppProvider>
  );
}
