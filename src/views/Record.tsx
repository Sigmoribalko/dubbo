import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { beep } from "../components/confetti";
import { EffectPicker } from "../components/EffectPicker";
import { MicMeter } from "../components/MicMeter";
import { useAnimationFrame } from "../components/useAnimationFrame";
import { VideoErrorModal } from "../components/VideoErrorModal";
import { VoiceTrack } from "../components/VoiceTrack";
import { characterEnvelope, ENV_RATE, recordingEnvelope, type Envelope } from "../lib/audio/envelope";
import { useT } from "../i18n";
import type { EffectId } from "../lib/audio/effects";
import { composeLines, recordWindow } from "../lib/audio/compose";
import { decodeBlob, routeVideo, unlockAudio, VideoMixer, type MixTrack, type VideoDuck } from "../lib/audio/engine";
import { getMic, hasMic, micRms, pickMime, setMonitor } from "../lib/audio/mic";
import { sleep } from "../lib/util";
import { countDub, dubLimitReached } from "../lib/auth/auth";
import { reportLines, submitTake, useRoom } from "../net/room";
import { notify, useApp, useGame } from "../state/app";
import { effectOf, mixFor, myLines, originalDuck, originalMix, videoDuck } from "../state/game";
import { Caption } from "./Caption";
import { RecordingWait } from "./Online";

type Phase = "idle" | "count" | "rec" | "listen";

interface Session {
  cancelled: boolean;
  recorder: MediaRecorder | null;
}

/**
 * Record this device's role line by line: hear how the character says it, record, listen back,
 * redo if needed, move on. The last line's button submits all of them joined into one voice track.
 */
export function Record() {
  const t = useT();
  const game = useGame();
  const { touch } = useApp();
  const { snap, myId } = useRoom();
  const video = useRef<HTMLVideoElement>(null);
  const mixer = useRef<VideoMixer | null>(null);
  const session = useRef<Session | null>(null);
  const segmentEnd = useRef<number | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [count, setCount] = useState<number | null>(null);
  const [monitorOn, setMonitorOn] = useState(false);
  const [micReady, setMicReady] = useState(hasMic());
  const [videoError, setVideoError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [listening, setListening] = useState<"mine" | "original">("original");

  const roleId = game.myRoleId!;
  const role = game.scene.roles.find((r) => r.id === roleId);
  const lines = useMemo(() => myLines(game), [game]);
  const [idx, setIdx] = useState(() => Math.max(0, lines.findIndex((l) => !game.lineTakes[l.id])));
  const line = lines[idx];
  const take = line ? game.lineTakes[line.id] : undefined;
  const effect = effectOf(game, roleId);
  const busy = phase === "count" || phase === "rec";
  const recordedCount = lines.filter((l) => game.lineTakes[l.id]).length;
  const last = idx >= lines.length - 1;

  const time = useCallback(() => video.current?.currentTime ?? 0, []);

  // Timeline length: the video's own duration once known, else what the lines cover.
  const [videoDuration, setVideoDuration] = useState(0);
  const duration = Math.max(videoDuration, game.scene.duration, ...game.scene.lines.map((l) => l.end + 1));
  const [from, to] = line ? recordWindow(line, duration) : [0, 0];

  // How loud the character speaks over time (measured once per scene and role).
  const [reference, setReference] = useState<Envelope | null>(null);
  useEffect(() => {
    let live = true;
    characterEnvelope({ scene: game.scene, roleId, clips: game.clips, hasBackingTrack: !!game.bg, duration })
      .then((env) => { if (live) setReference(env); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.scene, roleId, Math.round(duration)]);

  // Your voice: drawn live while recording, then from the finished takes.
  const liveLevels = useRef<Float32Array | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useAnimationFrame(() => {
    const v = video.current;
    if (!v || v.paused) return;
    // A segment ends on its own, a little after the line.
    if (segmentEnd.current != null && v.currentTime >= segmentEnd.current) {
      const rec = session.current?.recorder;
      if (phaseRef.current === "rec") { if (rec?.state === "recording") { v.pause(); rec.stop(); } }
      else if (phaseRef.current === "listen") stopListening();
      return;
    }
    const levels = liveLevels.current;
    if (!levels || phaseRef.current !== "rec") return;
    const i = Math.floor(v.currentTime * ENV_RATE);
    if (i < levels.length) levels[i] = Math.max(levels[i], micRms());
  });
  const takesKey = lines.map((l) => (game.lineTakes[l.id] ? l.id : "")).join();
  const mine = useMemo(() => {
    const values = new Float32Array(Math.ceil(duration * ENV_RATE));
    for (const l of lines) {
      const tk = game.lineTakes[l.id];
      if (!tk) continue;
      const env = recordingEnvelope(tk.buffer, tk.offset, duration).values;
      const [a, b] = recordWindow(l, duration);
      for (let i = Math.floor(a * ENV_RATE); i < Math.min(values.length, Math.ceil(b * ENV_RATE)); i++) values[i] = Math.max(values[i], env[i]);
    }
    return { values };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takesKey, duration]);

  const dropMixer = () => { mixer.current?.destroy(); mixer.current = null; };
  const seek = (at: number) => {
    const v = video.current;
    if (!v) return;
    v.pause();
    try { v.currentTime = at; } catch { /* not loaded yet */ }
  };

  // The video's own soundtrack goes through Web Audio so its volume setting works everywhere.
  useEffect(() => { if (video.current) routeVideo(video.current); }, []);

  // Each line starts cued up at its lead-in.
  useEffect(() => { dropMixer(); segmentEnd.current = null; seek(from); setPhase("idle"); }, [idx, videoDuration]); // eslint-disable-line react-hooks/exhaustive-deps

  // Others see how far along you are.
  useEffect(() => { reportLines(recordedCount); }, [recordedCount]);

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

  /** Mine on top of everything else in the scene, for listening back. */
  const lineMix = (): MixTrack[] => (take ? [{ buffer: take.buffer, offset: take.offset, bus: "voice", effect }, ...mixFor(game, roleId)] : mixFor(game, roleId));

  const playSegment = async (tracks: MixTrack[], duck: VideoDuck, what: "mine" | "original") => {
    const v = video.current;
    if (!v || !line) return;
    await unlockAudio();
    dropMixer();
    seek(from);
    mixer.current = new VideoMixer(v, tracks, { duck });
    segmentEnd.current = to;
    setListening(what);
    setPhase("listen");
    v.play().catch(() => setPhase("idle"));
  };
  const listenOriginal = () => playSegment(originalMix(game), originalDuck(game), "original");
  const listenMine = () => playSegment(lineMix(), videoDuck(game, roleId), "mine");
  function stopListening() {
    dropMixer();
    segmentEnd.current = null;
    seek(from);
    setPhase("idle");
  }

  const record = async () => {
    const v = video.current;
    if (!v || busy || !line) return;
    if (dubLimitReached()) { notify(t.auth.limitReached); return; }
    await unlockAudio();
    let stream: MediaStream;
    try { stream = await getMic(); setMicReady(true); }
    catch { notify(t.record.noMic); return; }
    if (!window.MediaRecorder) { notify(t.record.noRecorder); return; }

    dropMixer();
    segmentEnd.current = null;
    seek(from);
    const lineId = line.id;
    const start = from;
    const s: Session = { cancelled: false, recorder: null };
    session.current = s;
    setPhase("count");
    for (const n of [3, 2, 1]) {
      if (s.cancelled) return;
      setCount(n);
      beep(520);
      await sleep(600);
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
    liveLevels.current = new Float32Array(Math.ceil(duration * ENV_RATE));
    setPhase("rec");

    // While you record, your character's original voice is silenced; everyone else stays as a cue.
    mixer.current = new VideoMixer(v, mixFor(game, roleId), { duck: videoDuck(game, roleId) });
    segmentEnd.current = to;
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
    segmentEnd.current = null;
    if (session.current === s) session.current = null;

    liveLevels.current = null;
    if (s.cancelled || t1 == null || !chunks.length) { setPhase("idle"); seek(start); return; }
    const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
    try {
      // Track time = video time + offset; the video started at `start`, (t1 - t0) after the recorder.
      game.lineTakes[lineId] = { blob, buffer: await decodeBlob(blob), offset: (t1 - t0) / 1000 - start };
      touch();
    } catch {
      notify(t.record.unreadable);
    }
    setPhase("idle");
    seek(start);
  };

  const stop = () => {
    const s = session.current;
    if (phase === "count" && s) { s.cancelled = true; session.current = null; setCount(null); setPhase("idle"); return; }
    if (phase === "rec" && s?.recorder && s.recorder.state !== "inactive") { video.current?.pause(); s.recorder.stop(); }
  };

  const chooseEffect = (id: EffectId) => {
    game.effects[roleId] = id;
    touch();
    // Re-style what is playing right now.
    if (phase === "listen" && listening === "mine") listenMine();
  };

  const goTo = (i: number) => { if (!busy) setIdx(Math.max(0, Math.min(lines.length - 1, i))); };

  /** Join every line into one voice track and send it. Each round is counted once on the account. */
  const submit = async () => {
    const missing = lines.findIndex((l) => !game.lineTakes[l.id]);
    if (missing >= 0) { setIdx(missing); notify(t.record.lineOf(missing + 1, lines.length)); return; }
    if (phase === "listen") stopListening();
    setSubmitting(true);
    try {
      if (!game.dubCounted) {
        if (!(await countDub(game.scene.title))) { notify(t.auth.limitReached); return; }
        game.dubCounted = true;
      }
      const track = await composeLines(lines, game.lineTakes, duration);
      game.tracks[roleId] = track;
      game.effects[roleId] = effect;
      touch();
      submitTake({ roleId, blob: track.blob, offset: track.offset, effect });
    } catch {
      notify(t.record.unreadable);
    } finally {
      setSubmitting(false);
    }
  };

  // Space starts/stops recording.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if (e.code !== "Space" || /INPUT|TEXTAREA|SELECT|BUTTON/.test((e.target as HTMLElement).tagName)) return;
    e.preventDefault();
    if (busy) stop();
    else if (!take && phase === "idle") record();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  // Sent: wait for the others with everyone's progress.
  if (snap && snap.players.find((p) => p.id === myId)?.submitted) return <RecordingWait snap={snap} />;

  const myName = game.cast[roleId];
  const playingWhat = phase === "listen" ? listening : null;

  return (
    <div className="wrap stack">
      <div className="row">
        <h2 style={{ flex: 1 }}>{lines.length ? t.record.lineOf(idx + 1, lines.length) : role?.name}</h2>
        {role && <span className="chip tag" style={{ ["--c" as string]: role.color }}>{myName ? `${myName} · ${role.name}` : role.name}</span>}
      </div>
      {lines.length > 1 && (
        <div className="chips" aria-hidden="true">
          {lines.map((l, i) => <span key={l.id} className={"chip pass" + (game.lineTakes[l.id] ? " done" : "") + (i === idx ? " cur" : "")} style={{ ["--c" as string]: role?.color }}>{i + 1}</span>)}
        </div>
      )}

      <div className={"stage" + (phase === "rec" ? " recording" : "")}>
        <video ref={video} src={game.videoUrl} playsInline preload="auto" onError={() => setVideoError(true)} onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (isFinite(d)) setVideoDuration(d); }} />
        <div className="tally">REC</div>
        {effect !== "none" && <div className="fx-badge">{t.effects[effect][0]}</div>}
        {count != null && <div className="countdown"><span key={count}>{count}</span></div>}
        <Progress video={video} />
      </div>

      {line ? (
        <>
          <Caption lines={game.scene.lines} roles={game.scene.roles} focusRoleId={roleId} time={time} />
          <VoiceTrack
            reference={reference}
            mine={recordedCount ? mine : null}
            live={liveLevels}
            lines={lines}
            color={role?.color ?? "#f2a516"}
            time={time}
            labels={{ character: t.record.trackCharacter(role?.name ?? ""), you: t.record.trackYou, measuring: t.record.trackMeasuring }}
          />
        </>
      ) : <p className="muted">{t.record.noLines}</p>}

      {line && (
        <div className="row rec-controls">
          {phase === "count" && <button className="small" onClick={stop}>{t.common.cancel}</button>}
          {phase === "rec" && <button className="rec" onClick={stop}>{t.record.stopRec}</button>}
          {!busy && (
            <>
              {playingWhat === "original" ? <button onClick={stopListening}>{t.common.stop}</button> : <button onClick={listenOriginal}>{t.record.listenOriginal}</button>}
              {take && (playingWhat === "mine" ? <button onClick={stopListening}>{t.common.stop}</button> : <button onClick={listenMine}>{t.record.listen}</button>)}
              <button className={take ? "" : "rec"} onClick={() => { if (phase === "listen") stopListening(); record(); }}>{take ? t.record.rerecord : t.record.rec}</button>
            </>
          )}
        </div>
      )}

      <div className="row">
        {idx > 0 && <button disabled={busy || submitting} onClick={() => goTo(idx - 1)}>{t.record.prev}</button>}
        <div className="spacer" />
        {submitting && <span className="muted fine">{t.record.submitting}</span>}
        {last ? (
          <button className="primary" disabled={busy || submitting || (!!line && !take)} onClick={submit}>{t.record.submit}</button>
        ) : (
          <button className="primary" disabled={busy || !take} onClick={() => goTo(idx + 1)}>{t.record.next}</button>
        )}
      </div>

      {micReady && <MicMeter />}
      {line && (
        <p className="muted fine">
          {take ? (last ? t.record.hintLastDone : t.record.hintLineDone) : t.record.hintLine}
          {!take && <span className="desktop-only"> {t.record.spaceHint}</span>}
        </p>
      )}

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
