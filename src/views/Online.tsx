import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { unlockAudio } from "../lib/audio/engine";
import { store } from "../lib/store";
import type { Pack } from "../lib/types";
import {
  capacityOf, createRoom, everyoneCast, hostCast, hostSelectScene, hostSetPublic, hostStart, hostToLobby, hostToScreening, inviteLink, joinRoom,
  leaveRoom, normalizeCode, onlinePlayers, pickRole, randomizeRoles, useRoom, type Player, type Snapshot,
} from "../net/room";
import { FileButton } from "../components/FileButton";
import { importFiles } from "../lib/pack/import";
import { findRooms, joinable, type FoundRoom } from "../net/finder";
import { displayName, useAuth } from "../lib/auth/auth";
import { notify, useApp } from "../state/app";

const NAME_KEY = "dubl-name";
const loadName = () => {
  const account = displayName(useAuth.getState().user);
  if (account) return account;
  try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; }
};
const saveName = (n: string) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ } };

type Intent = "create" | "join" | "find";

export function Online({ code: initialCode, packId, intent }: { code?: string; packId?: string; intent?: Intent }) {
  const t = useT();
  const { status, error, snap, isHost } = useRoom();

  // "Play" on a pack: preselect it once the room is up.
  const preselected = useRef(false);
  useEffect(() => {
    if (!packId || preselected.current || status !== "open" || !isHost || snap?.pack) return;
    preselected.current = true;
    store.getPack(packId).then((p) => { if (p?.scenes.length) hostSelectScene(p, p.scenes[0].id); });
  }, [packId, status, isHost, snap?.pack]);

  if (status === "open" && snap) {
    if (snap.phase === "lobby") return <Lobby snap={snap} />;
    if (snap.phase === "casting") return <Casting snap={snap} />;
    return <RecordingWait snap={snap} />;
  }

  if (status === "connecting") {
    return (
      <div className="wrap stack">
        <h2>{t.online.title}</h2>
        <div className="panel row"><div className="spinner" /><span>{t.online.connecting}</span></div>
      </div>
    );
  }
  const err = status === "error" ? error : null;
  if (intent === "find" && !initialCode) return <Finder error={err} />;
  return <Entry initialCode={initialCode} intent={initialCode ? "join" : intent} error={err} />;
}

/* ---------- create / join ---------- */

function Entry({ initialCode, intent, error }: { initialCode?: string; intent?: Intent; error: string | null }) {
  const t = useT();
  const go = useApp((s) => s.go);
  const [name, setName] = useState(loadName);
  const [code, setCode] = useState(initialCode ? normalizeCode(initialCode) : "");

  const withName = (fn: (n: string) => void) => async () => {
    const n = name.trim();
    if (!n) return notify(t.online.needName);
    saveName(n);
    await unlockAudio();
    fn(n);
  };

  // Known name + a clear intent: no need to ask again, go straight in.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || error || !name.trim()) return;
    if (initialCode && normalizeCode(initialCode).length === 5) { started.current = true; withName((n) => joinRoom(initialCode, n))(); }
    else if (intent === "create") { started.current = true; withName((n) => createRoom(n))(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="wrap stack">
      <div>
        <h2>{t.online.title}</h2>
        <p className="muted">{t.online.lead}</p>
      </div>
      {error && <div className="panel notice">{error}</div>}
      <label className="field">
        {t.online.yourName}
        <input value={name} maxLength={30} placeholder={t.online.namePlaceholder} onChange={(e) => setName(e.target.value)} autoFocus={!name} />
      </label>
      <div className={"grid-cards" + (intent === "create" ? " reverse" : "")}>
        <section className="panel stack">
          <div>
            <h3>{t.online.joinTitle}</h3>
            <p className="muted fine">{t.online.joinText}</p>
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (normalizeCode(code).length === 5) withName((n) => joinRoom(code, n))(); }}>
            <input className="code-input" value={code} onChange={(e) => setCode(normalizeCode(e.target.value))} placeholder={t.online.codePlaceholder} aria-label={t.online.joinTitle} autoCapitalize="characters" autoComplete="off" spellCheck={false} />
            <button className={code.length === 5 ? "primary" : ""} disabled={code.length !== 5}>{t.online.join}</button>
          </form>
        </section>
        <section className="panel stack">
          <div>
            <h3>{t.online.createTitle}</h3>
            <p className="muted fine">{t.online.createText}</p>
          </div>
          <button className={intent === "join" || code.length === 5 ? "" : "primary"} style={{ justifySelf: "start" }} onClick={withName((n) => createRoom(n))}>{t.online.create}</button>
        </section>
      </div>
      <button className="ghost" style={{ justifySelf: "start" }} onClick={() => { leaveRoom(); go({ name: "home" }); }}>← {t.online.back}</button>
    </div>
  );
}

/* ---------- find a public game ---------- */

function Finder({ error }: { error: string | null }) {
  const t = useT();
  const go = useApp((s) => s.go);
  const [name, setName] = useState(loadName);
  const [rooms, setRooms] = useState<FoundRoom[]>([]);
  const [searching, setSearching] = useState(false);
  const search = useRef<{ cancel(): void } | null>(null);

  /** One sweep over the public slots; `fresh` clears the list first, otherwise rooms are updated in place. */
  const sweep = (fresh: boolean) => {
    search.current?.cancel();
    const seen = new Set<string>();
    if (fresh) { setRooms([]); setSearching(true); }
    const s = findRooms((room) => { seen.add(room.code); setRooms((rs) => [...rs.filter((r) => r.code !== room.code), room]); });
    search.current = s;
    return s.done.catch(() => {}).then(() => {
      if (search.current !== s) return false;
      setSearching(false);
      if (!fresh) setRooms((rs) => rs.filter((r) => seen.has(r.code))); // drop rooms that went away
      return seen.size > 0;
    });
  };
  const refresh = () => { sweep(true); };

  // Keep the list live while this screen is open. A brand-new connection sometimes can't see
  // rooms for a few seconds, so an empty first sweep is retried quickly.
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const loop = async (first: boolean) => {
      const any = await sweep(first);
      if (alive) timer = window.setTimeout(() => loop(false), first && !any ? 2500 : 10000);
    };
    loop(true);
    return () => { alive = false; clearTimeout(timer); search.current?.cancel(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const withName = (fn: (n: string) => void) => async () => {
    const n = name.trim();
    if (!n) return notify(t.online.needName);
    saveName(n);
    search.current?.cancel();
    await unlockAudio();
    fn(n);
  };

  // Fullest rooms first so games fill up quickly; your own language first.
  const lang = document.documentElement.lang;
  const open = rooms.filter(joinable).sort((a, b) => Number(b.lang === lang) - Number(a.lang === lang) || b.players / b.capacity - a.players / a.capacity);

  return (
    <div className="wrap stack">
      <div>
        <h2>{t.online.findTitle}</h2>
        <p className="muted">{t.online.findLead}</p>
      </div>
      {error && <div className="panel notice">{error}</div>}
      <label className="field">
        {t.online.yourName}
        <input value={name} maxLength={30} placeholder={t.online.namePlaceholder} onChange={(e) => setName(e.target.value)} autoFocus={!name} />
      </label>

      <section className="panel stack" aria-live="polite">
        <div className="row">
          <h3 style={{ flex: 1 }}>{searching ? t.online.searching : `${t.online.findTitle} · ${open.length}`}</h3>
          {searching ? <div className="spinner" /> : <button className="small" onClick={refresh}>↻ {t.online.refresh}</button>}
        </div>
        {open.map((r) => (
          <div className="room-row" key={r.code}>
            <div className="room-info">
              <b>{r.scene}</b>
              <span className="muted fine">{r.pack} · {t.online.roomBy(r.host)} · {r.lang.toUpperCase()}</span>
            </div>
            <span className="seats" aria-label={t.online.playersOf(r.players, r.capacity)}>
              {Array.from({ length: r.capacity }, (_, i) => <i key={i} className={i < r.players ? "on" : ""} />)}
            </span>
            <span className="muted fine">{t.online.playersOf(r.players, r.capacity)}</span>
            <button className="small primary" onClick={withName((n) => joinRoom(r.code, n))}>{t.online.join}</button>
          </div>
        ))}
        {!searching && !open.length && <p className="muted">{t.online.noRooms}</p>}
      </section>

      <section className="panel stack">
        <div>
          <h3>{t.online.createOpen}</h3>
          <p className="muted fine">{t.online.createOpenText}</p>
        </div>
        <button style={{ justifySelf: "start" }} className={open.length ? "" : "primary"} onClick={withName((n) => createRoom(n, { public: true }))}>{t.online.createOpen}</button>
      </section>
      <button className="ghost" style={{ justifySelf: "start" }} onClick={() => { search.current?.cancel(); go({ name: "home" }); }}>← {t.online.back}</button>
    </div>
  );
}

/* ---------- lobby ---------- */

function Lobby({ snap }: { snap: Snapshot }) {
  const t = useT();
  const { isHost, myId } = useRoom();
  const scene = snap.scene;
  const mine = snap.players.find((p) => p.id === myId);
  const online = snap.players.filter((p) => p.online);
  const everyoneReady = online.every((p) => p.ready);
  const capacity = capacityOf(snap);
  const leave = useLeave();

  return (
    <div className="wrap stack">
      <Invite code={snap.code} />

      <div className="grid2">
        <section className="panel stack" aria-labelledby="scene-h">
          <h3 id="scene-h">{t.online.scene}</h3>
          {isHost && (
            <label className="switch" title={scene ? t.online.publicHint : t.online.publicNeedScene}>
              <input type="checkbox" checked={snap.public} disabled={!scene} onChange={(e) => hostSetPublic(e.target.checked)} />
              {t.online.publicToggle}
            </label>
          )}
          {isHost && <p className="muted fine">{scene ? t.online.publicHint : t.online.publicNeedScene}</p>}
          {isHost ? <ScenePicker snap={snap} /> : scene ? (
            <p><b>{scene.title}</b>{snap.pack ? <span className="muted"> · {snap.pack.name}</span> : null}</p>
          ) : <p className="muted">{t.online.waitScene}</p>}
        </section>

        <section className="panel stack" aria-labelledby="players-h">
          <h3 id="players-h">{t.online.players} · {Number.isFinite(capacity) ? t.online.capacity(online.length, capacity) : online.length}</h3>
          <ul className="players">
            {snap.players.map((p) => <PlayerRow key={p.id} p={p} snap={snap} me={p.id === myId} />)}
          </ul>
        </section>
      </div>

      <div className="row">
        <button className="ghost danger" onClick={leave}>{t.online.leave}</button>
        <div className="spacer" />
        {isHost ? (
          <>
            {snap.public && online.length < 2 && <span className="muted fine">{t.online.waitPlayers}</span>}
            {scene && !everyoneReady && <span className="muted fine">{t.online.needReady}</span>}
            <button className="primary" disabled={!scene || !everyoneReady} onClick={async () => { await unlockAudio(); hostCast(); }}>{t.online.startCasting}</button>
          </>
        ) : (
          <span className="muted">{mine?.ready === false ? t.online.downloading(mine.progress ?? 0) : t.online.waitHost}</span>
        )}
      </div>
    </div>
  );
}

function useLeave() {
  const t = useT();
  const go = useApp((s) => s.go);
  return () => {
    if (!confirm(t.online.leaveConfirm)) return;
    leaveRoom();
    useApp.getState().setGame(null);
    go({ name: "home" });
  };
}

/* ---------- casting: everyone picks a role ---------- */

function Casting({ snap }: { snap: Snapshot }) {
  const t = useT();
  const { isHost, myId } = useRoom();
  const leave = useLeave();
  const scene = snap.scene!;
  const mine = snap.players.find((p) => p.id === myId);
  const ready = everyoneCast(snap);
  return (
    <div className="wrap stack">
      <div>
        <h2>{t.online.castingTitle}</h2>
        <p className="muted"><b>{scene.title}</b>{snap.pack ? ` · ${snap.pack.name}` : ""}</p>
      </div>
      <section className="panel stack" aria-labelledby="roles-h">
        <div>
          <h3 id="roles-h">{t.online.roles}</h3>
          <p className="muted fine">{snap.public ? t.online.castingPublic : t.online.castingHint}</p>
        </div>
        <div className="role-grid">
          {scene.roles.map((r) => {
            const owner = snap.players.find((p) => p.roleId === r.id);
            const isMine = owner?.id === myId;
            const taken = !!owner && !isMine;
            return (
              <button
                key={r.id}
                className={"role-card" + (isMine ? " mine" : "") + (taken ? " taken" : "")}
                style={{ ["--c" as string]: r.color }}
                disabled={taken || snap.public}
                aria-pressed={isMine}
                onClick={() => pickRole(isMine ? null : r.id)}
              >
                <span className="role-dot" aria-hidden="true" />
                <span className="role-name">{r.name}</span>
                <span className="role-owner">{owner ? (isMine ? `${owner.name} (${t.online.you})` : owner.name) : t.online.free}</span>
              </button>
            );
          })}
        </div>
        <div className="row">
          {snap.public ? (
            isHost && <button onClick={randomizeRoles}>{t.online.shuffleRoles}</button>
          ) : (
            <>
              <button onClick={() => pickRole(null)} disabled={!mine?.roleId}>{t.online.reset}</button>
              <button onClick={randomizeRoles}>{t.online.shuffleRoles}</button>
            </>
          )}
        </div>
        {scene.roles.length > snap.players.filter((p) => p.roleId).length && <p className="muted fine">{t.online.unassignedHint}</p>}
      </section>

      <section className="panel stack" aria-labelledby="players-h">
        <h3 id="players-h">{t.online.players}</h3>
        <ul className="players">
          {snap.players.map((p) => <PlayerRow key={p.id} p={p} snap={snap} me={p.id === myId} />)}
        </ul>
      </section>

      <div className="row">
        <button className="ghost danger" onClick={leave}>{t.online.leave}</button>
        {isHost && <button className="ghost" onClick={hostToLobby}>{t.online.toScenes}</button>}
        <div className="spacer" />
        {!ready && <span className="muted fine">{t.online.needAllRoles}</span>}
        {isHost ? (
          <button className="primary" disabled={!ready} onClick={async () => { await unlockAudio(); hostStart(); }}>{t.online.start}</button>
        ) : ready && <span className="muted">{t.online.waitHost}</span>}
      </div>
    </div>
  );
}

function Invite({ code }: { code: string }) {
  const t = useT();
  const link = inviteLink(code);
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => notify(t.online.copied), () => notify(t.importer.copyFailed));
  const canShare = !!link && typeof navigator.share === "function";
  return (
    <section className="panel invite" aria-label={t.online.room}>
      <div>
        <span className="muted fine">{t.online.room}</span>
        <div className="room-code">{code}</div>
      </div>
      <div className="stack" style={{ gap: 8, flex: 1, minWidth: 220 }}>
        <div className="row">
          {link && <button className="small primary" onClick={() => copy(link)}>{t.online.copyLink}</button>}
          <button className="small" onClick={() => copy(code)}>{t.online.copyCode}</button>
          {canShare && <button className="small" onClick={() => navigator.share({ title: "DubParty", text: t.online.shareText(code), url: link! }).catch(() => {})}>{t.online.share}</button>}
        </div>
        <p className="muted fine">{link ? t.online.inviteHint : t.online.fileHint}</p>
      </div>
    </section>
  );
}

function PlayerRow({ p, snap, me }: { p: Player; snap: Snapshot; me: boolean }) {
  const t = useT();
  const role = snap.scene?.roles.find((r) => r.id === p.roleId);
  const status = !p.online ? t.online.offline : !p.ready ? (p.progress != null ? t.online.downloading(p.progress) : t.online.waitingScene) : null;
  return (
    <li className={"player" + (p.online ? "" : " off")}>
      <span className="avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
      <span className="player-name">
        {p.name}
        {(p.host || me) && <small className="muted"> · {[p.host && t.online.host, me && t.online.you].filter(Boolean).join(", ")}</small>}
      </span>
      {status ? <span className="muted fine">{status}</span> : role ? <span className="chip tag" style={{ ["--c" as string]: role.color }}>{role.name}</span> : <span className="muted fine">{t.online.noRole}</span>}
      {p.progress != null && !p.ready && <span className="mini-bar" aria-hidden="true"><i style={{ transform: `scaleX(${p.progress})` }} /></span>}
    </li>
  );
}

function ScenePicker({ snap }: { snap: Snapshot }) {
  const t = useT();
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [importing, setImporting] = useState(false);
  const load = () => store.listPacks().then((all) => { const withScenes = all.filter((p) => p.scenes.length); setPacks(withScenes); return withScenes; });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const runImport = async (files: File[]) => {
    setImporting(true);
    try {
      const [p] = await importFiles(files);
      await load();
      const sc = p?.scenes.find((x) => x.roles.length >= onlinePlayers(snap).length);
      if (p && sc) hostSelectScene(p, sc.id);
    } catch {
      notify(t.importer.failTitle);
    } finally {
      setImporting(false);
    }
  };
  const importButton = importing
    ? <div className="row"><div className="spinner" /><span className="muted fine">{t.online.importing}</span></div>
    : <FileButton className="small" multiple onFiles={runImport}>{t.online.importPack}</FileButton>;
  if (!packs) return <div className="spinner" />;
  if (!packs.length) return <div className="stack" style={{ gap: 10 }}><p className="muted">{t.online.noPacks}</p>{importButton}</div>;
  const pack = packs.find((p) => p.id === snap.pack?.id);
  const players = onlinePlayers(snap).length;
  const fits = (sc: { roles: unknown[] }) => sc.roles.length >= players;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <label className="field">
        {t.common.pack}
        <select value={pack?.id ?? ""} onChange={(e) => { const p = packs.find((x) => x.id === e.target.value); const sc = p?.scenes.find(fits); if (p && sc) hostSelectScene(p, sc.id); }}>
          {!pack && <option value="">{t.online.choosePack}</option>}
          {packs.map((p) => <option key={p.id} value={p.id}>{p.name || t.common.untitled}</option>)}
        </select>
      </label>
      {pack && (
        <label className="field">
          {t.common.scene}
          <select value={snap.scene?.id ?? ""} onChange={(e) => hostSelectScene(pack, e.target.value)}>
            {pack.scenes.map((s) => <option key={s.id} value={s.id} disabled={!fits(s)}>{(s.title || t.common.scene) + (fits(s) ? "" : t.online.tooSmall(players))}</option>)}
          </select>
        </label>
      )}
      <div>{importButton}</div>
    </div>
  );
}

/* ---------- waiting while others record ---------- */

export function RecordingWait({ snap }: { snap: Snapshot }) {
  const t = useT();
  const { isHost, myId } = useRoom();
  const leave = useLeave();
  const cast = snap.players.filter((p) => p.roleId);
  const done = cast.filter((p) => p.submitted).length;
  const mine = snap.players.find((p) => p.id === myId);
  const linesOf = (p: Player) => snap.scene?.lines.filter((l) => l.roleId === p.roleId).length ?? 0;
  // Who has submitted first, then who is closest to finishing.
  const order = [...cast].sort((a, b) => Number(b.submitted) - Number(a.submitted) || (linesOf(a) - a.linesDone) - (linesOf(b) - b.linesDone));
  return (
    <div className="wrap stack">
      <h2>{mine?.submitted ? t.online.youSubmitted : t.online.recordingTitle}</h2>
      {!mine?.roleId && <p className="muted">{t.online.spectator}</p>}
      <section className="panel stack" aria-live="polite">
        <p><b>{t.online.submittedOf(done, cast.length)}</b></p>
        <ul className="players">
          {order.map((p) => {
            const role = snap.scene?.roles.find((r) => r.id === p.roleId);
            return (
              <li className={"player" + (p.online ? "" : " off")} key={p.id}>
                <span className="avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="player-name">{p.name}{p.id === myId && <small className="muted"> · {t.online.you}</small>}</span>
                {role && <span className="chip tag" style={{ ["--c" as string]: role.color }}>{role.name}</span>}
                <span className={p.submitted ? "ok" : "muted fine"}>
                  {p.submitted ? t.online.sentMark : !p.online ? t.online.offline : t.online.linesLeft(linesOf(p) - p.linesDone)}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
      <div className="row">
        <button className="ghost danger" onClick={leave}>{t.online.leave}</button>
        <div className="spacer" />
        {isHost && done > 0 && <button onClick={hostToScreening}>{t.online.watchNow}</button>}
      </div>
    </div>
  );
}
