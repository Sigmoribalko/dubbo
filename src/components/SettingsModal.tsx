import { useEffect, useId, useState } from "react";
import { useLang, useT, type Lang } from "../i18n";
import { useTheme, type ThemeMode } from "../state/theme";
import { unlockAudio } from "../lib/audio/engine";
import { getMic, hasMic, listMics, useMicState } from "../lib/audio/mic";
import { notify } from "../state/app";
import { useSettings, type Settings } from "../state/settings";
import { MicMeter } from "./MicMeter";
import { Modal } from "./Modal";

type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

function Slider({ k, label, max = 100, hint }: { k: NumKey; label: string; max?: number; hint?: string }) {
  const value = useSettings((s) => s[k]);
  const set = useSettings((s) => s.set);
  const id = useId();
  return (
    <div className="slider">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={0} max={max} step={5} value={value} onChange={(e) => set({ [k]: +e.target.value })} />
      <output htmlFor={id}>{value}%</output>
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

function Toggle({ k, label }: { k: BoolKey; label: string }) {
  const value = useSettings((s) => s[k]);
  const set = useSettings((s) => s.set);
  return (
    <label className="switch">
      <input type="checkbox" checked={value} onChange={(e) => set({ [k]: e.target.checked })} />
      {label}
    </label>
  );
}

export function SettingsModal({ onClose }: { onClose(): void }) {
  const t = useT();
  const s = t.settings;
  const micDevice = useSettings((x) => x.micDevice);
  const set = useSettings((x) => x.set);
  const reset = useSettings((x) => x.reset);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micOpen, setMicOpen] = useState(hasMic());

  useEffect(() => {
    const refresh = () => { setMicOpen(hasMic()); listMics().then(setDevices); };
    refresh();
    useMicState.listeners.add(refresh);
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      useMicState.listeners.delete(refresh);
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  const testMic = async () => {
    await unlockAudio();
    try { await getMic(); } catch { notify(t.record.noMic); }
  };

  return (
    <Modal
      title={s.title}
      onClose={onClose}
      actions={<><button className="ghost" onClick={reset}>{s.reset}</button><div className="spacer" /><button className="primary" onClick={onClose}>{s.done}</button></>}
    >
      <section className="settings-group" aria-label={s.playback}>
        <h4>{s.playback}</h4>
        <Slider k="master" label={s.master} />
        <Slider k="voices" label={s.voices} max={200} />
        <Slider k="video" label={s.video} hint={s.videoHint} />
        <Slider k="bg" label={s.bg} />
        <Slider k="lines" label={s.lines} />
      </section>

      <section className="settings-group" aria-label={s.mic}>
        <h4>{s.mic}</h4>
        <div className="slider">
          <label htmlFor="mic-device">{s.device}</label>
          <select id="mic-device" value={micDevice} onChange={(e) => set({ micDevice: e.target.value })}>
            <option value="">{s.defaultDevice}</option>
            {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || s.micN(i + 1)}</option>)}
          </select>
        </div>
        <Slider k="micGain" label={s.micGain} max={300} hint={s.micHint} />
        {micOpen ? <MicMeter label={s.level} /> : <button className="small" style={{ justifySelf: "start" }} onClick={testMic}>{s.allowMic}</button>}
        <div className="row">
          <Toggle k="noiseSuppression" label={s.noiseSuppression} />
          <Toggle k="echoCancellation" label={s.echoCancellation} />
          <Toggle k="autoGain" label={s.autoGain} />
        </div>
        <Slider k="monitor" label={s.monitor} />
      </section>

      <InterfaceSettings />

      <section className="settings-group" aria-label={s.other}>
        <h4>{s.other}</h4>
        <Slider k="ui" label={s.ui} />
      </section>
    </Modal>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange(v: T): void }) {
  return (
    <div className="slider">
      <span>{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={v} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{text}</button>
        ))}
      </div>
    </div>
  );
}

function InterfaceSettings() {
  const t = useT();
  const s = t.settings;
  const { lang, setLang } = useLang();
  const { mode, setMode } = useTheme();
  return (
    <section className="settings-group" aria-label={s.interface}>
      <h4>{s.interface}</h4>
      <Segmented<Lang> label={s.language} value={lang} options={[["ru", "Русский"], ["en", "English"]]} onChange={setLang} />
      <Segmented<ThemeMode> label={s.theme} value={mode} options={[["auto", s.themeAuto], ["light", s.themeLight], ["dark", s.themeDark]]} onChange={setMode} />
    </section>
  );
}
