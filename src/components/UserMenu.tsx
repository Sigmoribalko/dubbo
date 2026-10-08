import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { authEnabled, displayName, signOut, useAuth } from "../lib/auth/auth";
import { notify, useApp } from "../state/app";

/** "Sign in" button, or the signed-in user's name with a small menu. */
export function UserMenu() {
  const t = useT();
  const go = useApp((s) => s.go);
  const { ready, user } = useAuth();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!authEnabled || !ready) return null;
  if (!user) return <button className="small" onClick={() => go({ name: "auth", mode: "signin" })}>{t.auth.signIn}</button>;

  const name = displayName(user);
  return (
    <div className="user-menu" ref={box}>
      <button className="small ghost user-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <span className="user-name">{name}</span>
      </button>
      {open && (
        <div className="menu panel" role="menu">
          <div className="muted fine">{user.email}</div>
          <button role="menuitem" className="small" onClick={async () => { setOpen(false); await signOut(); notify(t.auth.signedOut); }}>{t.auth.signOut}</button>
        </div>
      )}
    </div>
  );
}
