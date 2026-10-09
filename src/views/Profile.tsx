import { useEffect } from "react";
import { useT } from "../i18n";
import { authEnabled, displayName, refreshProfile, signOut, useAuth } from "../lib/auth/auth";
import { notify, useApp } from "../state/app";

/** Your account and stats: dubs recorded and "best voice" wins. */
export function Profile() {
  const t = useT();
  const p = t.profile;
  const go = useApp((s) => s.go);
  const { ready, user, profile } = useAuth();

  useEffect(() => { refreshProfile(); }, []);

  if (!authEnabled || (ready && !user)) {
    return (
      <div className="wrap stack profile">
        <h2>{p.title}</h2>
        <div className="panel stack">
          <p className="muted">{p.signInToSee}</p>
          <div className="row">
            <button className="primary" onClick={() => go({ name: "auth", mode: "signin" })}>{t.auth.signIn}</button>
            <button onClick={() => go({ name: "auth", mode: "signup" })}>{t.auth.signUpShort}</button>
          </div>
        </div>
      </div>
    );
  }
  if (!user) return <div className="wrap"><div className="spinner" aria-label={t.common.loading} /></div>;

  const name = profile?.name || displayName(user);
  const limit = profile?.dubs_limit;

  return (
    <div className="wrap stack profile">
      <header className="profile-head">
        <span className="avatar profile-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <div>
          <h2>{name}</h2>
          <p className="muted">{user.email}</p>
        </div>
      </header>

      <div className="stat-grid">
        <div className="stat">
          <span className="stat-value">{profile ? profile.dubs_used : "—"}</span>
          <span className="stat-label">{p.dubs}</span>
          {limit != null && profile && <span className="muted fine">{p.dubsLimit(Math.max(0, limit - profile.dubs_used))}</span>}
        </div>
        <div className="stat stat-wins">
          <span className="stat-value">{profile ? profile.wins : "—"}</span>
          <span className="stat-label">{p.wins}</span>
        </div>
      </div>

      <section className="panel stack" aria-labelledby="plan-h">
        <h3 id="plan-h">{p.plan}</h3>
        <p className="muted">{profile?.plan === "free" || !profile ? p.planFree : profile.plan}{limit == null ? ` · ${p.unlimited}` : ""}</p>
      </section>

      <button className="ghost danger" style={{ justifySelf: "start" }} onClick={async () => { await signOut(); notify(t.auth.signedOut); go({ name: "home" }); }}>
        {t.auth.signOut}
      </button>
    </div>
  );
}
