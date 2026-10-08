import { useMemo, useRef } from "react";
import { useT } from "../i18n";
import type { Line, Role } from "../lib/types";
import { useAnimationFrame } from "./useAnimationFrame";

const PX_PER_SECOND = 140;

interface Props {
  lines: Line[];
  roles: Role[];
  duration?: number;
  /** Dim every line not spoken by this role. */
  focusRoleId?: string | null;
  /** Current playhead in seconds, polled every frame. */
  time: () => number;
  emptyText?: string;
  label?: string;
}

/** Scrolling "film strip" of lines; the red playhead marks "speak now". */
export function Band({ lines, roles, duration = 0, focusRoleId, time, emptyText, label }: Props) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const sorted = useMemo(() => [...lines].sort((a, b) => a.start - b.start), [lines]);
  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);
  const last = sorted.reduce((m, l) => Math.max(m, l.end), 0);
  const width = Math.max(2000, (Math.max(duration, last) + 30) * PX_PER_SECOND);

  useAnimationFrame(() => {
    const el = box.current, tr = track.current;
    if (!el || !tr || !el.offsetParent) return;
    const t = time();
    tr.style.transform = `translate3d(${el.clientWidth * 0.25 - t * PX_PER_SECOND}px,0,0)`;
    const cues = tr.children;
    for (let i = 0; i < sorted.length; i++) cues[i]?.classList.toggle("now", t >= sorted[i].start && t < sorted[i].end);
  });

  return (
    <div className="band" ref={box} role="img" aria-label={label ?? t.caption.bandLabel}>
      <div className="band-track" ref={track} style={{ width, ["--pxs" as string]: `${PX_PER_SECOND}px` }}>
        {sorted.map((l) => {
          const r = roleById.get(l.roleId);
          return (
            <div
              key={l.id}
              className={"cue" + (focusRoleId && l.roleId !== focusRoleId ? " dim" : "")}
              style={{ left: l.start * PX_PER_SECOND, width: Math.max(36, (l.end - l.start) * PX_PER_SECOND), ["--c" as string]: r?.color ?? "#ccc" }}
            >
              <b>{r?.name ?? t.common.noRole}</b>
              <span>{l.text || "…"}</span>
            </div>
          );
        })}
      </div>
      <div className="band-head" />
      {!sorted.length && <div className="band-empty">{emptyText ?? t.caption.bandEmpty}</div>}
    </div>
  );
}
