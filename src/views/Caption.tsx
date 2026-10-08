import { useEffect, useState } from "react";
import { useT } from "../i18n";
import type { Line, Role } from "../lib/types";

interface Props {
  lines: Line[];
  roles: Role[];
  focusRoleId: string | null;
  time(): number;
}

/** "Who speaks now / next" caption under the video, refreshed 10× a second. */
export function Caption({ lines, roles, focusRoleId, time }: Props) {
  const tr = useT();
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT(time()), 100);
    return () => clearInterval(id);
  }, [time]);

  const mine = lines.filter((l) => !focusRoleId || l.roleId === focusRoleId).sort((a, b) => a.start - b.start);
  const now = mine.find((l) => t >= l.start && t < l.end);
  const next = mine.find((l) => l.start > t);
  const name = (l: Line) => roles.find((r) => r.id === l.roleId)?.name ?? "";
  const key = now ? "n" + now.id : next ? "x" + next.id : mine.length ? "end" : "free";
  const small = now ? tr.caption.now(name(now)) : next ? tr.caption.inSec(name(next), (next.start - t).toFixed(1)) : mine.length ? tr.caption.noMore : tr.caption.free;
  const text = now ? now.text || "…" : next ? next.text || "…" : mine.length ? " " : tr.caption.sayAnything;

  return (
    <div className="caption" aria-live="off">
      <div className="cap" key={key}>
        <small>{small}</small>
        {text}
      </div>
    </div>
  );
}
