import { useEffect } from "react";
import { Icon } from "./components/Icon";
import { SettingsModal } from "./components/SettingsModal";
import { Toaster } from "./components/Toast";
import { UserMenu } from "./components/UserMenu";
import { useT } from "./i18n";
import { leaveRoom, useRoom } from "./net/room";
import { useApp, type View } from "./state/app";
import { hasAnyRecording } from "./state/game";
import { useRoomDirector } from "./state/online";
import "./state/theme";
import { Auth } from "./views/Auth";
import { Editor } from "./views/Editor";
import { Home } from "./views/Home";
import { Online } from "./views/Online";
import { Packs } from "./views/Packs";
import { Record } from "./views/Record";
import { Screening } from "./views/Screening";

/** Screens where the game is running: navigation stays out of the way. */
const IN_GAME: View["name"][] = ["record", "screen"];

export function App() {
  const t = useT();
  const view = useApp((s) => s.view);
  const game = useApp((s) => s.game);
  const go = useApp((s) => s.go);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  useRoomDirector();

  // Invite links look like ?room=K7MXQ.
  useEffect(() => {
    const code = new URLSearchParams(location.search).get("room");
    if (!code) return;
    history.replaceState(null, "", location.pathname);
    go({ name: "online", code });
  }, [go]);

  // Warn before closing the tab with unsaved takes.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (hasAnyRecording(useApp.getState().game)) e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  /** Navigating away from a room asks first. */
  const navigate = (to: View) => {
    if (useRoom.getState().status === "open") {
      if (!confirm(t.online.leaveConfirm)) return;
      leaveRoom();
      useApp.getState().setGame(null);
    }
    go(to);
  };

  const section = view.name === "packs" || view.name === "editor" ? "packs" : "play";
  const inGame = IN_GAME.includes(view.name);

  return (
    <div className={"app" + (inGame ? " in-game" : "")}>
      <header className="topbar">
        <button className="wordmark" onClick={() => navigate({ name: "home" })} aria-label={t.header.home}>Dubbo<i>.</i></button>
        <nav className="top-nav" aria-label={t.header.home}>
          <button className={section === "play" ? "on" : ""} aria-current={section === "play" ? "page" : undefined} onClick={() => navigate({ name: "home" })}>{t.nav.play}</button>
          <button className={section === "packs" ? "on" : ""} aria-current={section === "packs" ? "page" : undefined} onClick={() => navigate({ name: "packs" })}>{t.nav.packs}</button>
        </nav>
        <div className="spacer" />
        <UserMenu />
        <button className="small ghost icon-btn" onClick={() => setSettingsOpen(true)} aria-label={t.header.settings} title={t.header.settings}><Icon name="gear" size={20} /></button>
      </header>

      <main className="view" key={view.name + ("packId" in view ? view.packId ?? "" : "")}>
        {view.name === "home" && <Home />}
        {view.name === "packs" && <Packs />}
        {view.name === "editor" && <Editor packId={view.packId} />}
        {view.name === "record" && game && <Record />}
        {view.name === "screen" && game && <Screening />}
        {view.name === "auth" && <Auth mode={view.mode} />}
        {view.name === "online" && <Online code={view.code} packId={view.packId} intent={view.intent} />}
      </main>

      {!inGame && (
        <nav className="bottom-nav" aria-label={t.header.home}>
          <button className={section === "play" ? "on" : ""} aria-current={section === "play" ? "page" : undefined} onClick={() => navigate({ name: "home" })}>
            <Icon name="home" size={22} /><span>{t.nav.play}</span>
          </button>
          <button className={section === "packs" ? "on" : ""} aria-current={section === "packs" ? "page" : undefined} onClick={() => navigate({ name: "packs" })}>
            <Icon name="film" size={22} /><span>{t.nav.packs}</span>
          </button>
          <button onClick={() => setSettingsOpen(true)}>
            <Icon name="gear" size={22} /><span>{t.nav.settings}</span>
          </button>
        </nav>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <Toaster />
    </div>
  );
}
