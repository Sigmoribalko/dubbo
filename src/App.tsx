import { useEffect, useState } from "react";
import { Icon } from "./components/Icon";
import { LangSwitch } from "./components/LangSwitch";
import { SettingsModal } from "./components/SettingsModal";
import { Toaster } from "./components/Toast";
import { useT } from "./i18n";
import { useApp } from "./state/app";
import { hasAnyRecording } from "./state/game";
import { Editor } from "./views/Editor";
import { Auth } from "./views/Auth";
import { Home } from "./views/Home";
import { UserMenu } from "./components/UserMenu";
import { Online } from "./views/Online";
import { leaveRoom, useRoom } from "./net/room";
import { useRoomDirector } from "./state/online";
import { Record } from "./views/Record";
import { Screening } from "./views/Screening";

type Theme = "light" | "dark" | null;

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return (localStorage.getItem("dubl-theme") as Theme) || null; } catch { return null; }
  });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);
  const toggle = () => {
    const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem("dubl-theme", next); } catch { /* private mode */ }
  };
  return [theme, toggle];
}

export function App() {
  const t = useT();
  const view = useApp((s) => s.view);
  const game = useApp((s) => s.game);
  const go = useApp((s) => s.go);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const [, toggleTheme] = useTheme();
  useRoomDirector();

  // Invite links look like ?room=K7MXQ.
  useEffect(() => {
    const code = new URLSearchParams(location.search).get("room");
    if (!code) return;
    history.replaceState(null, "", location.pathname);
    go({ name: "online", code });
  }, [go]);

  const home = () => {
    if (useRoom.getState().status === "open") {
      if (!confirm(t.online.leaveConfirm)) return;
      leaveRoom();
      useApp.getState().setGame(null);
    }
    go({ name: "home" });
  };

  // Warn before closing the tab with unsaved takes.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (hasAnyRecording(useApp.getState().game)) e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  return (
    <>
      <header className="topbar">
        <button className="wordmark" onClick={home} aria-label={t.header.home}>Dubbo<i>.</i></button>
        <div className="spacer" />
        {view.name === "home" && <LangSwitch />}
        <UserMenu />
        <button className="small ghost icon-btn" onClick={() => setSettingsOpen(true)} aria-label={t.header.settings} title={t.header.settings}><Icon name="gear" size={20} /></button>
        <button className="small ghost icon-btn" onClick={toggleTheme} aria-label={t.header.theme} title={t.header.theme}><Icon name="contrast" size={20} /></button>
      </header>
      <main className="view" key={view.name + ("packId" in view ? view.packId ?? "" : "")}>
        {view.name === "home" && <Home />}
        {view.name === "editor" && <Editor packId={view.packId} />}
        {view.name === "record" && game && <Record />}
        {view.name === "screen" && game && <Screening />}
        {view.name === "auth" && <Auth mode={view.mode} />}
        {view.name === "online" && <Online code={view.code} packId={view.packId} intent={view.intent} />}
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <Toaster />
    </>
  );
}
