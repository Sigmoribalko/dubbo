import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Omit to make the modal non-dismissable (e.g. while work is in progress). */
  onClose?: () => void;
}

export function Modal({ title, children, actions, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const target = panel.current?.querySelector<HTMLElement>("button.primary, button, [tabindex]");
    (target ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close.current?.(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, []);
  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="panel stack" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={panel} tabIndex={-1}>
        <h3 id="modal-title">{title}</h3>
        {children}
        {actions && <div className="row">{actions}</div>}
      </div>
    </div>
  );
}
