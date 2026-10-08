import { saveFile } from "../download";
import { audioCtx, createBuses, loadWorklets, masterOut, routeVideo, VideoMixer, type MixTrack, type VideoDuck } from "./engine";
import { pickMime } from "./mic";

export interface VideoExportJob {
  promise: Promise<"saved" | "cancelled" | "declined">;
  cancel(): void;
}

type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };

function captureVideo(v: HTMLVideoElement): MediaStream {
  const c = v as CapturableVideo;
  return (c.captureStream ?? c.mozCaptureStream)!.call(v);
}

export function canExportVideo() {
  const v = document.createElement("video") as CapturableVideo;
  return !!window.MediaRecorder && !!(v.captureStream || v.mozCaptureStream) &&
    !!pickMime(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]);
}

/**
 * Render a take to a video file by playing it in real time and recording the canvas-free
 * video stream plus the Web Audio mix (voices with their effects, backing track, original).
 */
export function exportVideo(opts: {
  video: HTMLVideoElement;
  src: string;
  tracks: MixTrack[];
  /** Mute the video's own voices during these ranges. */
  duck?: VideoDuck;
  fileName: string;
  onProgress(current: number, total: number): void;
}): VideoExportJob {
  const { video: v } = opts;
  const mime = pickMime(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]);
  const c = audioCtx();
  const dest = c.createMediaStreamDestination();
  // Same per-category levels as on screen; the master volume only affects what you hear while saving.
  const bus = c.createGain();
  bus.connect(dest);
  bus.connect(masterOut());
  const levels = createBuses(bus);

  let mixer: VideoMixer | null = null;
  let rec: MediaRecorder | null = null;
  let cancelled = false;
  let finish: (r: "saved" | "cancelled" | "declined") => void = () => {};
  let fail: (e: unknown) => void = () => {};
  const chunks: Blob[] = [];

  const cleanup = () => {
    mixer?.destroy();
    v.pause();
    v.removeAttribute("src");
    v.load();
    levels.dispose();
    bus.disconnect();
  };

  const promise = new Promise<"saved" | "cancelled" | "declined">((res, rej) => { finish = res; fail = rej; });

  (async () => {
    await loadWorklets(c);
    await c.resume();
    routeVideo(v, levels);
    v.src = opts.src;
    await new Promise<void>((r, j) => {
      v.addEventListener("loadedmetadata", () => r(), { once: true });
      v.addEventListener("error", () => j(new Error("video")), { once: true });
    });
    mixer = new VideoMixer(v, opts.tracks, { out: levels, duck: opts.duck });
    v.addEventListener("timeupdate", () => opts.onProgress(v.currentTime, v.duration));
    v.addEventListener("playing", () => {
      if (rec) return;
      const cap = captureVideo(v);
      rec = new MediaRecorder(new MediaStream([...cap.getVideoTracks(), ...dest.stream.getAudioTracks()]), { mimeType: mime });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        cleanup();
        if (cancelled) return finish("cancelled");
        const ext = mime.includes("mp4") ? "mp4" : "webm";
        finish(await saveFile(`${opts.fileName}.${ext}`, new Blob(chunks, { type: mime })));
      };
      rec.start(500);
    }, { once: true });
    v.addEventListener("ended", () => { if (rec?.state !== "inactive") rec?.stop(); }, { once: true });
    await v.play();
  })().catch((e) => { cleanup(); fail(e); });

  return {
    promise,
    cancel() {
      cancelled = true;
      if (rec && rec.state !== "inactive") rec.stop();
      else { cleanup(); finish("cancelled"); }
    },
  };
}
