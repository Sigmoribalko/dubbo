import { useId } from "react";
import { EFFECTS, type EffectId } from "../lib/audio/effects";
import { useT } from "../i18n";

interface Props {
  value: EffectId;
  onChange(id: EffectId): void;
  disabled?: boolean;
}

export function EffectPicker({ value, onChange, disabled }: Props) {
  const name = useId();
  const t = useT();
  return (
    <fieldset className="fx-grid" disabled={disabled}>
      <legend className="visually-hidden">{t.effectsLegend}</legend>
      {EFFECTS.map((fx) => {
        const [label, hint] = t.effects[fx.id];
        return (
          <label className="fx" key={fx.id} title={hint}>
            <input type="radio" name={name} value={fx.id} checked={value === fx.id} onChange={() => onChange(fx.id)} />
            <span className="fx-icon" aria-hidden="true">{fx.icon}</span>
            <span className="fx-name">{label}</span>
            <span className="fx-hint">{hint}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
