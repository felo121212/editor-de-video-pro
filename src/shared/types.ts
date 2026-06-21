export type VideoStatus = 'uploaded' | 'processing' | 'ready' | 'failed';
export type JobType = 'ingest' | 'generate_waveform' | 'generate_thumbnails' | 'detect_silence' | 'transcribe' | 'render';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type TimelineEventType = 'cut' | 'zoom' | 'image_overlay' | 'subtitle_style';

export interface VideoProject {
  id: string;
  title: string;
  originalPath: string;
  proxyPath?: string | null;
  renderPath?: string | null;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  status: VideoStatus;
  createdAt: string;
  updatedAt: string;
}

export interface VideoJob {
  id: string;
  videoId: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  errorText?: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface SilenceSegment {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  action: 'keep' | 'cut';
}

export interface TranscriptSegment {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  text: string;
  source: 'openai' | 'whisper_local' | 'manual' | 'fallback';
}

export interface SubtitleCue {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  text: string;
  style: SubtitleStyle;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  primaryColor: string;
  outlineColor: string;
  backColor: string;
  bold: boolean;
  uppercase: boolean;
  position: 'bottom' | 'middle' | 'top';
}

export interface ImageAsset {
  id: string;
  videoId: string;
  label: string;
  filePath: string;
  triggerWords: string[];
  position: {
    x: number;
    y: number;
    scale: number;
  };
  timingMode: 'word_match' | 'manual';
}

export interface WaveformPoint {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  amplitude: number;
}

export interface VideoThumbnail {
  id: string;
  videoId: string;
  timeMs: number;
  filePath: string;
  width: number;
  height: number;
}

export interface TimelineEvent {
  id: string;
  videoId: string;
  type: TimelineEventType;
  startMs: number;
  endMs: number;
  enabled: boolean;
  payload: Record<string, unknown>;
}

export interface RenderRecord {
  id: string;
  videoId: string;
  jobId: string;
  outputPath: string;
  status: JobStatus;
  settings: Record<string, unknown>;
  createdAt: string;
}

export interface EditorState {
  video: VideoProject;
  jobs: VideoJob[];
  silences: SilenceSegment[];
  transcript: TranscriptSegment[];
  subtitles: SubtitleCue[];
  assets: ImageAsset[];
  waveform: WaveformPoint[];
  thumbnails: VideoThumbnail[];
  timeline: TimelineEvent[];
  renders: RenderRecord[];
}

export const defaultSubtitleStyle: SubtitleStyle = {
  fontFamily: 'Inter',
  fontSize: 48,
  primaryColor: '#ffffff',
  outlineColor: '#11101c',
  backColor: '#7c3aed',
  bold: true,
  uppercase: false,
  position: 'bottom'
};
