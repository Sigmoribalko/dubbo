import { useCallback, useEffect, useRef, useState } from "react";
import { Band } from "../components/Band";
import { confetti } from "../components/confetti";
import { Modal } from "../components/Modal";
import { VideoErrorModal } from "../components/VideoErrorModal";
import { useT } from "../i18n";
import { effectIcon } from "../lib/audio/effects";
import { routeVideo, unlockAudio, VideoMixer, type MixTrack, type VideoDuck } from "../lib/audio/engine";
import { canExportVideo, exportVideo, type VideoExportJob } from "../lib/audio/exportVideo";
import { fmtTime, prefersReducedMotion, safeFileName } from "../lib/util";
import { hostPlayAll, hostReveal, hostToLobby, leaveRoom, onPlayAll, useRoom, vote, voteCounts } from "../net/room";
import { notify, useApp, useGame } from "../state/app";
import { castRoles, originalDuck, effectOf, mixFor, originalMix, videoDuck } from "../state/game";

type OnScreen = "dub" | "original" | null;

/** Shared screening: everyone watches on their own device, votes once, the host announces the winner. */
export function Screening() {
  const t = useT();
  const game = useGame();
  const { go, setGame } = useApp();
  const { snap, isHost, myId } = useRoom();
  const video = useRef<HTMLVideoElement>(null);
  const mixer = useRef<VideoMixer | null>(null);
  const [onScreen, setOnScreen] = useState<OnScreen>(null);
  const [exporting, setExporting] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const time = useCallback(() => video.current?.currentTime ?? 0, []);
  const hasOriginal = game.scene.lines.some((l) => l.clip && game.clips[l.clip]);
  const winners = snap?.winners ?? null;
  const counts = snap ? voteCounts(snap) : {};
  const myVote = snap?.votes[myId];

  const show = async (what: "dub" | "original", autoplay = true) => {
    const v = video.current;
    if (!v) return;
    await unlockAudio();
    mixer.current?.destroy();
    v.pause();
    try { v.currentTime = 0; } catch { /* not loaded yet */ }
    // Rebuilt every time so recordings that arrived since are included.
    mixer.current = what === "original" ? new VideoMixer(v, originalMix(game), { duck: originalDuck(game) }) : new VideoMixer(v, mixFor(game), { duck: videoDuck(game) });
    setOnScreen(what);
    if (autoplay) v.play().catch(() => {});
  };

  useEffect(() => {
    if (video.current) routeVideo(video.current);
    show("dub", false);
    const offPlay = onPlayAll(() => show("dub"));
    return () => { offPlay(); mixer.current?.destroy(); mixer.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Celebrate on every device when the host announces the result.
  const celebrated = useRef<string | null>(null);
  useEffect(() => {
    const key = winners?.join() ?? null;
    if (!key || celebrated.current === key) return;
    celebrated.current = key;
    confetti();
    const names = winners!.map((id) => game.cast[id]).filter(Boolean).join(", ");
    notify(winners!.length > 1 ? t.screen.tie : t.screen.bestIs(names));
    requestAnimationFrame(() => document.querySelector(".take.winner")?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" }));
  }, [winners, game.cast, t]);

  const save = () => {
    if (!canExportVideo()) return notify(t.screen.noExport);
    mixer.current?.destroy();
    mixer.current = null;
    video.current?.pause();
    setOnScreen(null);
    setExporting(true);
  };

  const leave = () => {
    if (!confirm(t.online.leaveConfirm)) return;
    leaveRoom();
    setGame(null);
    go({ name: "home" });
  };

  return (
    <div className="wrap stack">
      <h2>{t.screen.title}</h2>
      <div className="stage">
        <video ref={video} src={game.videoUrl} playsInline controls preload="auto" onError={() => setVideoError(true)} />
      </div>
      <div className="caption">
        {onScreen && <div className="cap" key={onScreen}><small>{t.common.onScreen}</small>{onScreen === "original" ? t.screen.originalLines : t.screen.ourDub}</div>}
      </div>
      <Band lines={game.scene.lines} roles={game.scene.roles} duration={game.scene.duration} time={time} />

      <div className="row">
        <button className="primary" onClick={() => show("dub")}>{t.screen.watch}</button>
        {isHost && <button onClick={hostPlayAll}>{t.online.showAll}</button>}
        {hasOriginal && <button onClick={() => show("original")}>{t.screen.original}</button>}
        <button onClick={save}>{t.screen.saveVideo}</button>
        <div className="spacer" />
        {isHost ? <button onClick={hostToLobby}>{t.online.nextScene}</button> : <button className="ghost danger" onClick={leave}>{t.online.leave}</button>}
      </div>

      <section className="stack" aria-labelledby="best-h">
        <div className="row">
          <div style={{ flex: 1 }}>
            <h3 id="best-h">{t.screen.bestVoice}</h3>
            <p className="muted fine">{t.screen.bestVoiceHint}</p>
          </div>
          {isHost ? <button className="primary" onClick={hostReveal}>{t.online.reveal}</button> : <span className="muted fine">{t.online.waitReveal}</span>}
        </div>
        {castRoles(game).map((role) => {
          const mine = role.id === game.myRoleId;
          const win = winners?.includes(role.id);
          const effect = effectOf(game, role.id);
          const recorded = !!game.tracks[role.id];
          return (
            <div className={"take" + (win ? " winner" : "")} key={role.id}>
              <div className="row">
                <span className="chip tag" style={{ ["--c" as string]: role.color }}>{role.name}</span>
                <h3 style={{ flex: 1 }}>{win ? "🏆 " : ""}{game.cast[role.id]}{mine ? <small className="muted"> · {t.online.you}</small> : null}</h3>
                {effect !== "none" && <span className="muted fine">{effectIcon(effect)} {t.effects[effect][0]}</span>}
              </div>
              <div className="row">
                {mine && <button className="small" onClick={() => go({ name: "record" })}>{recorded ? t.screen.rerecord : t.screen.record}</button>}
                {!recorded && !mine && <span className="muted fine">{t.online.recording}</span>}
                <div className="spacer" />
                <span className="muted fine">{t.online.votes(counts[role.id] ?? 0)}</span>
                {mine ? (
                  <span className="muted fine">{t.online.ownRole}</span>
                ) : (
                  <button className={"small" + (myVote === role.id ? " primary" : "")} aria-pressed={myVote === role.id} onClick={() => vote(role.id)}>
                    {myVote === role.id ? t.online.voted : t.online.vote}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {exporting && (
        <ExportModal
          title={game.scene.title}
          src={game.videoUrl}
          tracks={mixFor(game)}
          duck={videoDuck(game)}
          fileName={`Dubbo - ${safeFileName(game.scene.title || t.common.scene)}`}
          onDone={() => setExporting(false)}
        />
      )}
      {videoError && <VideoErrorModal onClose={() => setVideoError(false)} />}
    </div>
  );
}

function ExportModal(props: { title: string; src: string; tracks: MixTrack[]; duck: VideoDuck; fileName: string; onDone(): void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const job = useRef<VideoExportJob | null>(null);
  const [progress, setProgress] = useState("");

  useEffect(() => {
    if (!video.current || job.current) return;
    const j = exportVideo({
      video: video.current,
      src: props.src,
      tracks: props.tracks,
      duck: props.duck,
      fileName: props.fileName,
      onProgress: (cur, total) => setProgress(t.screen.exportProgress(fmtTime(cur), fmtTime(total))),
    });
    job.current = j;
    j.promise
      .then((r) => { if (r === "saved") notify(t.screen.exportSaved); })
      .catch(() => notify(t.screen.exportFailed))
      .finally(props.onDone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal title={t.screen.exportTitle(props.title)} actions={<><span className="muted" style={{ flex: 1 }}>{progress}</span><button className="small" onClick={() => job.current?.cancel()}>{t.common.cancel}</button></>}>
      <p className="muted">{t.screen.exportText}</p>
      <div className="stage"><video ref={video} playsInline /></div>
    </Modal>
  );
}
