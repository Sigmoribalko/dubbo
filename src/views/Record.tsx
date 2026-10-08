import { useCallback, useEffect, useRef, useState } from "react";
import { Band } from "../components/Band";
import { beep } from "../components/confetti";
import { EffectPicker } from "../components/EffectPicker";
import { MicMeter } from "../components/MicMeter";
import { useAnimationFrame } from "../components/useAnimationFrame";
import { VideoErrorModal } from "../components/VideoErrorModal";
import { useT } from "../i18n";
import { effectIcon, type EffectId } from "../lib/audio/effects";
import { decodeBlob, routeVideo, unlockAudio, VideoMixer } from "../lib/audio/engine";
import { getMic, hasMic, pickMime, setMonitor } from "../lib/audio/mic";
import { sleep } from "../lib/util";
import { roundTakes, setTakeEffect, submitTake, useRoom } from "../net/room";
import { notify, useApp, useGame } from "../state/app";
import { castRoles, effectOf, mixFor, voicedRanges } from "../state/game";
import { Caption } from "./Caption";

type Phase = "idle" | "count" | "rec" | "listen";

interface Session {
  cancelled: boolean;
  recorder: MediaRecorder | null;
}

/** Record this device's role, try effects, then send the take to the room. */
export function Record() {
  const t = useT();
  const game = useGame();
  const { touch } = useApp();
  const snap = useRoom((s) => s.snap);
  useRoom((s) => s.takesRev);
  const video = useRef<HTMLVideoElement>(null);
  const mixer = useRef<VideoMixer | null>(null);
  const session = useRef<Session | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [count, setCount] = useState<number | null>(null);
  const [monitorOn, setMonitorOn] = useState(false);
  const [micReady, setMicReady] = useState(hasMic());
  const [videoError, setVideoError] = useState(false);
  /** Effect chosen before the first take. */
  const [nextEffect, setNextEffect] = useState<EffectId>("none");

  const roleId = game.myRoleId!;
  const role = game.scene.roles.find((r) => r.id === roleId);
  const recorded = game.tracks[roleId];
  const effect = recorded ? effectOf(game, roleId) : nextEffect;
  const busy = phase === "count" || phase === "rec";
  const sent = !!recorded && roundTakes.get(roleId)?.blob === recorded.blob;
  const castPlayers = snap?.players.filter((p) => p.roleId) ?? [];
  const submittedCount = castPlayers.filter((p) => p.submitted).length;

  const time = useCallback(() => video.current?.currentTime ?? 0, []);
  const dropMixer = () => { mixer.current?.destroy(); mixer.current = null; };
  const rewind = () => {
    const v = video.current;
    if (!v) return;
    v.pause();
    try { v.currentTime = 0; } catch { /* not loaded yet */ }
  };

  // The video's own soundtrack goes through Web Audio so its volume setting works everywhere.
  useEffect(() => { if (video.current) routeVideo(video.current); }, []);

  // Live monitor follows the selected effect.
  useEffect(() => {
    if (monitorOn && micReady) setMonitor(effect);
    else setMonitor(null);
  }, [monitorOn, micReady, effect]);

  // Leaving the screen: stop everything, discard an unfinished recording.
  useEffect(() => () => {
    if (session.current) {
      session.current.cancelled = true;
      if (session.current.recorder?.state === "recording") session.current.recorder.stop();
    }
    dropMixer();
    setMonitor(null);
  }, []);

  const record = async () => {
    const v = video.current;
    if (!v || busy) return;
    await unlockAudio();
    let stream: MediaStream;
    try { stream = await getMic(); setMicReady(true); }
    catch { notify(t.record.noMic); return; }
    if (!window.MediaRecorder) { notify(t.record.noRecorder); return; }

    dropMixer();
    rewind();
    const s: Session = { cancelled: false, recorder: null };
    session.current = s;
    setPhase("count");
    for (const n of [3, 2, 1]) {
      if (s.cancelled) return;
      setCount(n);
      beep(520);
      await sleep(800);
    }
    setCount(null);
    if (s.cancelled) return;
    beep(880, 0.18);

    const mime = pickMime(["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]);
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    s.recorder = rec;
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    // Hook `stop` up front so stopping at any moment still finalises (or discards) cleanly.
    const stopped = new Promise<void>((r) => { rec.onstop = () => r(); });
    const started = new Promise<void>((r) => { rec.onstart = () => r(); });
    rec.start(250);
    await started;
    const t0 = performance.now();
    setPhase("rec");

    // While you record, your character's original voice is silenced; everyone else stays as a cue.
    mixer.current = new VideoMixer(v, mixFor(game, roleId), { duck: voicedRanges(game, roleId) });
    const playing = new Promise<number>((r) => v.addEventListener("playing", () => r(performance.now()), { once: true }));
    const onEnded = () => { if (rec.state !== "inactive") rec.stop(); };
    v.addEventListener("ended", onEnded, { once: true });
    try {
      await v.play();
    } catch {
      s.cancelled = true;
      rec.stop();
      notify(t.record.videoWontPlay);
    }
    const t1 = await Promise.race([playing, stopped.then(() => null)]);
    await stopped;
    v.removeEventListener("ended", onEnded);
    v.pause();
    dropMixer();
    if (session.current === s) session.current = null;

    if (s.cancelled || t1 == null || !chunks.length) { setPhase("idle"); return; }
    const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
    try {
      game.tracks[roleId] = { blob, buffer: await decodeBlob(blob), offset: (t1 - t0) / 1000 };
      game.effects[roleId] = effect;
      touch();
    } catch {
      notify(t.record.unreadable);
    }
    setPhase("idle");
    rewind();
  };

  const stop = () => {
    const s = session.current;
    if (phase === "count" && s) { s.cancelled = true; session.current = null; setCount(null); setPhase("idle"); return; }
    if (phase === "rec" && s?.recorder && s.recorder.state !== "inactive") { video.current?.pause(); s.recorder.stop(); }
  };

  const listen = async () => {
    const v = video.current;
    if (!v) return;
    await unlockAudio();
    dropMixer();
    rewind();
    mixer.current = new VideoMixer(v, mixFor(game), { duck: voicedRanges(game) });
    setPhase("listen");
    v.addEventListener("ended", () => setPhase((p) => (p === "listen" ? "idle" : p)), { once: true });
    v.play().catch(() => setPhase("idle"));
  };

  const stopListening = () => { dropMixer(); rewind(); setPhase("idle"); };

  const chooseEffect = (id: EffectId) => {
    setNextEffect(id);
    if (!recorded) return;
    game.effects[roleId] = id;
    touch();
    if (sent) setTakeEffect(roleId, id);
    // Re-style what is playing right now.
    if (phase === "listen" && video.current) { dropMixer(); mixer.current = new VideoMixer(video.current, mixFor(game), { duck: voicedRanges(game) }); }
  };

  const redo = () => {
    delete game.tracks[roleId];
    touch();
    record();
  };

  const send = () => {
    if (recorded) submitTake({ roleId, blob: recorded.blob, offset: recorded.offset, effect });
  };

  // Space starts/stops recording.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if (e.code !== "Space" || /INPUT|TEXTAREA|SELECT|BUTTON/.test((e.target as HTMLElement).tagName)) return;
    e.preventDefault();
    if (busy) stop();
    else if (!recorded && phase === "idle") record();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  const hearsOthers = mixFor(game, roleId).length > 0;
  const myName = game.cast[roleId];

  return (
    <div className="wrap stack">
      <h2>{myName ? `${myName}, ${role?.name ?? ""}` : role?.name}</h2>

      <div className="chips" aria-label={t.record.passes}>
        {castRoles(game).map((r) => {
          const done = !!game.tracks[r.id];
          const fx = game.effects[r.id];
          return (
            <span key={r.id} className={"chip pass" + (done ? " done" : "") + (r.id === roleId ? " cur" : "")} style={{ ["--c" as string]: r.color }}>
              {r.name}{done && fx && fx !== "none" ? ` ${effectIcon(fx)}` : ""}
            </span>
          );
        })}
      </div>

      <div className={"stage" + (phase === "rec" ? " recording" : "")}>
        <video ref={video} src={game.videoUrl} playsInline preload="auto" onError={() => setVideoError(true)} />
        <div className="tally">REC</div>
        {effect !== "none" && <div className="fx-badge">{effectIcon(effect)} {t.effects[effect][0]}</div>}
        {count != null && <div className="countdown"><span key={count}>{count}</span></div>}
        <Progress video={video} />
      </div>

      <Caption lines={game.scene.lines} roles={game.scene.roles} focusRoleId={phase === "listen" ? null : roleId} time={time} />
      <Band lines={game.scene.lines} roles={game.scene.roles} duration={game.scene.duration} focusRoleId={phase === "listen" ? null : roleId} time={time} />

      <div className="row">
        {phase === "count" && <button className="small" onClick={stop}>{t.common.cancel}</button>}
        {phase === "rec" && <button className="rec" onClick={stop}>{t.record.stopRec}</button>}
        {phase === "idle" && !recorded && <button className="rec" onClick={record}>{t.record.rec}</button>}
        {(phase === "idle" || phase === "listen") && recorded && (
          <>
            {phase === "listen" ? <button onClick={stopListening}>{t.common.stop}</button> : <button onClick={listen}>{t.record.listen}</button>}
            <button onClick={redo}>{t.record.rerecord}</button>
            <div className="spacer" />
            <button className="primary" disabled={sent} onClick={send}>{sent ? t.online.sent : t.online.send}</button>
          </>
        )}
      </div>

      {micReady && <MicMeter />}
      {sent && <p><b>{t.online.waitOthers(submittedCount, castPlayers.length)}</b></p>}
      <p className="muted fine">
        {sent ? t.online.sentHint : recorded ? t.record.hintDone : hearsOthers ? t.record.hintHear : t.record.hintSolo}
      </p>

      <section className="panel stack" aria-labelledby="fx-h">
        <div className="row">
          <h3 id="fx-h" style={{ flex: 1 }}>{t.record.voice}</h3>
          <label className="switch">
            <input
              type="checkbox"
              checked={monitorOn}
              onChange={async (e) => {
                const on = e.target.checked;
                if (on) {
                  await unlockAudio();
                  try { await getMic(); setMicReady(true); } catch { notify(t.record.noMic); return; }
                }
                setMonitorOn(on);
              }}
            />
            {t.record.monitor}
          </label>
        </div>
        <EffectPicker value={effect} onChange={chooseEffect} disabled={busy} />
        <p className="muted fine">
          {t.record.fxNote}
          {monitorOn && t.record.monitorWarn}
        </p>
      </section>

      {videoError && <VideoErrorModal onClose={() => setVideoError(false)} />}
    </div>
  );
}

function Progress({ video }: { video: React.RefObject<HTMLVideoElement | null> }) {
  const bar = useRef<HTMLElement>(null);
  useAnimationFrame(() => {
    const v = video.current;
    if (bar.current && v?.duration) bar.current.style.transform = `scaleX(${Math.min(1, v.currentTime / v.duration)})`;
  });
  return <div className="progress"><i ref={bar} /></div>;
}
