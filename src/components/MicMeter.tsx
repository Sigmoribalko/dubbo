import { useRef } from "react";
import { useT } from "../i18n";
import { micLevel } from "../lib/audio/mic";
import { useAnimationFrame } from "./useAnimationFrame";

export function MicMeter({ label }: { label?: string }) {
  const t = useT();
  const bar = useRef<HTMLElement>(null);
  useAnimationFrame(() => { if (bar.current) bar.current.style.transform = `scaleX(${micLevel()})`; });
  return (
    <div className="meter">
      <span>{label ?? t.meter}</span>
      <div className="meter-bar"><i ref={bar} /></div>
    </div>
  );
}
