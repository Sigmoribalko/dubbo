import { create } from "zustand";

export type ThemeMode = "auto" | "light" | "dark";
const KEY = "dubl-theme";

function load(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch { /* storage unavailable */ }
  return "auto";
}

function apply(mode: ThemeMode) {
  if (mode === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}

export const useTheme = create<{ mode: ThemeMode; setMode(m: ThemeMode): void }>((set) => ({
  mode: load(),
  setMode: (mode) => {
    set({ mode });
    apply(mode);
    try {
      if (mode === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch { /* private mode */ }
  },
}));

apply(useTheme.getState().mode);
