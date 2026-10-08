import { useLang, useT, type Lang } from "../i18n";

const LANGS: Array<[Lang, string]> = [["ru", "RU"], ["en", "EN"]];

/** RU / EN segmented switch. */
export function LangSwitch() {
  const { lang, setLang } = useLang();
  const t = useT();
  return (
    <div className="lang" role="radiogroup" aria-label={t.header.language}>
      {LANGS.map(([id, label]) => (
        <button key={id} role="radio" aria-checked={lang === id} className={lang === id ? "on" : ""} onClick={() => setLang(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}
