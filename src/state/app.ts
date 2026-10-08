import { create } from "zustand";
import type { Game } from "./game";

export type View =
  | { name: "home" }
  | { name: "packs" }
  | { name: "editor"; packId: string }
  | { name: "record" }
  | { name: "screen" }
  | { name: "online"; code?: string; packId?: string; intent?: "create" | "join" | "find" }
  | { name: "auth"; mode?: "signin" | "signup" };

interface Toast { id: number; text: string }

interface AppState {
  view: View;
  game: Game | null;
  /** Bumped whenever the (mutable) game changes, so subscribers re-render. */
  rev: number;
  toast: Toast | null;
  settingsOpen: boolean;
  go(view: View): void;
  setSettingsOpen(open: boolean): void;
  setGame(game: Game | null): void;
  touch(): void;
  notify(text: string): void;
}

let toastId = 0;

export const useApp = create<AppState>((set) => ({
  view: { name: "home" },
  game: null,
  rev: 0,
  toast: null,
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  go: (view) => { set({ view }); window.scrollTo(0, 0); },
  setGame: (game) => set((s) => ({ game, rev: s.rev + 1 })),
  touch: () => set((s) => ({ rev: s.rev + 1 })),
  notify: (text) => set({ toast: { id: ++toastId, text } }),
}));

export const notify = (text: string) => useApp.getState().notify(text);

/** Subscribe to the current game and its revision counter. */
export function useGame(): Game {
  const game = useApp((s) => s.game);
  useApp((s) => s.rev);
  if (!game) throw new Error("No game in progress");
  return game;
}
