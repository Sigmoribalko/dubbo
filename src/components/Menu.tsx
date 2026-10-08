import { useEffect, useRef, useState, type ReactNode } from "react";

/** A button that opens a small popover menu; closes on outside click, Escape or choosing an item. */
export function Menu({ label, children, className = "small", align = "right", ariaLabel }: { label: ReactNode; children: ReactNode; className?: string; align?: "left" | "right"; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={box}>
      <button className={className} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && (
        <div className={"menu panel " + align} role="menu" onClick={(e) => { if ((e.target as HTMLElement).closest("button, label")) setTimeout(() => setOpen(false), 0); }}>
          {children}
        </div>
      )}
    </div>
  );
}
