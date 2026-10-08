export interface Role {
  id: string;
  name: string;
  color: string;
}

export interface Line {
  id: string;
  roleId: string;
  /** Seconds from the start of the scene video. */
  start: number;
  end: number;
  text: string;
  /** Media key of the original voice clip for this line, if the pack has one. */
  clip?: string;
}

export interface Scene {
  /** Also the media key of the scene video. */
  id: string;
  title: string;
  mediaType: string;
  ext: string;
  duration: number;
  roles: Role[];
  lines: Line[];
  /** Media key of the backing track (music and ambience without voices). */
  bg?: string;
  bgExt?: string;
}

export interface Pack {
  id: string;
  name: string;
  author?: string;
  scenes: Scene[];
  updated: number;
}

export interface RecordedTrack {
  blob: Blob;
  buffer: AudioBuffer;
  /** Seconds between recorder start and the video actually playing. */
  offset: number;
}
