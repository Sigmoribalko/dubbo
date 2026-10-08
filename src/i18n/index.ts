import { create } from "zustand";
import { en } from "./en";
import { ru, type Dict } from "./ru";

export type Lang = "ru" | "en";
export type { Dict };

const dicts: Record<Lang, Dict> = { ru, en };
const KEY = "dubl-lang";

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "ru" || saved === "en") return saved;
  } catch { /* storage unavailable */ }
  return /^(ru|uk|be|kk)\b/i.test(navigator.language) ? "ru" : "en";
}

export const useLang = create<{ lang: Lang; setLang(l: Lang): void }>((set) => ({
  lang: initialLang(),
  setLang: (lang) => {
    set({ lang });
    try { localStorage.setItem(KEY, lang); } catch { /* private mode */ }
  },
}));

const applyDocument = (lang: Lang) => {
  document.documentElement.lang = lang;
  document.title = dicts[lang].meta.title;
};
applyDocument(useLang.getState().lang);
useLang.subscribe((s) => applyDocument(s.lang));

/** Current dictionary, reactive. */
export const useT = (): Dict => dicts[useLang((s) => s.lang)];

/** Current dictionary for non-React code (toasts, default names). */
export const t = (): Dict => dicts[useLang.getState().lang];
