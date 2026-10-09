import { create } from "zustand";

/** Audio and device preferences. Volumes are percentages; they apply live and persist between visits. */
export interface Settings {
  master: number;
  /** Players' recorded voices. */
  voices: number;
  /** The scene video's own soundtrack. Original voices of dubbed roles are muted automatically. */
  video: number;
  /** Backing track: music and ambience without voices. */
  bg: number;
  /** Original voice lines from the pack, for roles nobody voices. */
  lines: number;
  /** Microphone input gain applied to recordings. */
  micGain: number;
  /** "" = system default. */
  micDevice: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  /** Hearing yourself through headphones. */
  monitor: number;
  /** Countdown beeps. */
  ui: number;
}

export const DEFAULT_SETTINGS: Settings = {
  master: 100,
  voices: 100,
  video: 100,
  bg: 80,
  lines: 100,
  micGain: 100,
  micDevice: "",
  noiseSuppression: true,
  echoCancellation: true,
  autoGain: true,
  monitor: 90,
  ui: 60,
};

const KEY = "dubl-settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
      saved.voices = Math.min(100, saved.voices); // the scale used to go to 200%
      return saved;
    }
  } catch { /* storage unavailable or corrupt */ }
  return { ...DEFAULT_SETTINGS };
}

interface SettingsState extends Settings {
  set(patch: Partial<Settings>): void;
  reset(): void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),
  set: (patch) => {
    set(patch);
    const { set: _s, reset: _r, ...values } = get();
    try { localStorage.setItem(KEY, JSON.stringify(values)); } catch { /* private mode */ }
  },
  reset: () => get().set({ ...DEFAULT_SETTINGS }),
}));

export const settings = () => useSettings.getState();
