import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { displayName, signOut, useAuth } from "../lib/auth/auth";
import { notify, useApp } from "../state/app";

/** "Sign in" / "Sign up", or the signed-in user's name with a small menu. */
export function UserMenu() {
  const t = useT();
  const go = useApp((s) => s.go);
  const { ready, user, profile } = useAuth();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  if (!ready) return null;
  if (!user) {
    return (
      <div className="auth-buttons">
        <button className="small ghost" onClick={() => go({ name: "auth", mode: "signin" })}>{t.auth.signIn}</button>
        <button className="small primary" onClick={() => go({ name: "auth", mode: "signup" })}>{t.auth.signUpShort}</button>
      </div>
    );
  }

  const name = displayName(user);
  return (
    <div className="user-menu" ref={box}>
      <button className="small ghost user-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <span className="user-name">{name}</span>
      </button>
      {open && (
        <div className="menu panel right" role="menu">
          <div className="menu-info">
            <b>{name}</b>
            <span className="muted fine">{user.email}</span>
            {profile && (
              <span className="fine">
                {profile.dubs_limit == null ? t.auth.dubsUnlimited(profile.dubs_used) : t.auth.dubsLeft(profile.dubs_used, profile.dubs_limit)} · {t.profile.winsShort(profile.wins)}
              </span>
            )}
          </div>
          <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); go({ name: "profile" }); }}>{t.profile.title}</button>
          <button role="menuitem" className="menu-item" onClick={async () => { setOpen(false); await signOut(); notify(t.auth.signedOut); }}>{t.auth.signOut}</button>
        </div>
      )}
    </div>
  );
}
