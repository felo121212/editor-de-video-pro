import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { createId } from '../db/store.js';
import { extractAudio } from './ffmpeg.service.js';
import { ensureVideoDir } from './storage.service.js';
import { defaultSubtitleStyle, SubtitleCue, SubtitleGenerationSettings, TranscriptSegment, VideoProject } from '../../shared/types.js';

interface TranscriptionSegment {
  start?: number;
  end?: number;
  text?: string;
}

interface TranscriptionWord {
  start?: number;
  end?: number;
  word?: string;
}

export async function transcribe(video: VideoProject) {
  const audioDir = await ensureVideoDir('tmp', video.id);
  const audioPath = path.join(audioDir, 'audio.mp3');
  await extractAudio(video.originalPath, audioPath);

  if (!env.transcriptionApiKey) {
    const fallback = makeFallbackTranscript(video);
    return {
      transcript: fallback,
      subtitles: transcriptToSubtitles(fallback),
      warning: 'No transcription API key is set; created editable placeholder transcript.'
    };
  }

  const audio = await fs.readFile(audioPath);
  const wantsTimestamps = env.transcriptionModel.toLowerCase().includes('whisper');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', env.transcriptionModel);
  form.append('response_format', wantsTimestamps ? 'verbose_json' : 'json');
  if (wantsTimestamps) {
    form.append('timestamp_granularities[]', 'segment');
    form.append('timestamp_granularities[]', 'word');
  }
  if (env.transcriptionLanguage) form.append('language', env.transcriptionLanguage);
  if (env.transcriptionPrompt) form.append('prompt', env.transcriptionPrompt);

  const response = await fetch(env.transcriptionApiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.transcriptionApiKey}`
    },
    body: form
  });

  if (!response.ok) {
    const text = await response.text();
    const fallback = makeFallbackTranscript(video, `Transcripcion fallo: ${response.status}. Edita este texto manualmente.`);
    return { transcript: fallback, subtitles: transcriptToSubtitles(fallback), warning: text };
  }

  const data = await response.json();
  const segments = Array.isArray(data.segments) ? (data.segments as TranscriptionSegment[]) : [];
  const words = Array.isArray(data.words) ? (data.words as TranscriptionWord[]) : [];
  const transcript = segments.length
    ? segmentsToTranscript(video.id, segments)
    : words.length
      ? wordsToTranscript(video.id, words)
      : makeFallbackTranscript(video, String(data.text ?? 'Transcripcion lista para editar.'));

  return { transcript, subtitles: transcriptToSubtitles(transcript), warning: null };
}

export function transcriptToSubtitles(transcript: TranscriptSegment[], options: Partial<SubtitleGenerationSettings> = {}): SubtitleCue[] {
  const settings: SubtitleGenerationSettings = {
    wordsPerCue: clampInt(options.wordsPerCue, 2, 9, 5),
    maxCharsPerCue: clampInt(options.maxCharsPerCue, 10, 80, 34),
    minCueMs: clampInt(options.minCueMs, 350, 3000, 700),
    maxCueMs: clampInt(options.maxCueMs, 900, 7000, 2400),
    style: options.style ?? defaultSubtitleStyle
  };
  return transcript.flatMap((segment) => splitSegmentIntoSubtitleCues(segment, settings));
}

function segmentsToTranscript(videoId: string, segments: TranscriptionSegment[]): TranscriptSegment[] {
  return segments.map((segment) => ({
    id: createId(),
    videoId,
    startMs: Math.round(Number(segment.start ?? 0) * 1000),
    endMs: Math.round(Number(segment.end ?? segment.start ?? 0) * 1000),
    text: String(segment.text ?? '').trim(),
    source: 'openai' as const
  })).filter((segment) => segment.text && segment.endMs > segment.startMs);
}

function wordsToTranscript(videoId: string, words: TranscriptionWord[]): TranscriptSegment[] {
  const cleanWords = words
    .map((word) => ({
      text: String(word.word ?? '').trim(),
      startMs: Math.round(Number(word.start ?? 0) * 1000),
      endMs: Math.round(Number(word.end ?? word.start ?? 0) * 1000)
    }))
    .filter((word) => word.text && word.endMs >= word.startMs);
  const rows: TranscriptSegment[] = [];
  for (let index = 0; index < cleanWords.length; index += 10) {
    const chunk = cleanWords.slice(index, index + 10);
    rows.push({
      id: createId(),
      videoId,
      startMs: chunk[0].startMs,
      endMs: Math.max(chunk[chunk.length - 1].endMs, chunk[0].startMs + 800),
      text: chunk.map((word) => word.text).join(' '),
      source: 'openai'
    });
  }
  return rows;
}

function splitSegmentIntoSubtitleCues(segment: TranscriptSegment, settings: SubtitleGenerationSettings): SubtitleCue[] {
  const words = segment.text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const duration = Math.max(segment.endMs - segment.startMs, 1200);
  const chunks = chunkWords(words, settings.wordsPerCue, settings.maxCharsPerCue);
  const cues: SubtitleCue[] = [];
  let usedWords = 0;
  for (const chunk of chunks) {
    const startRatio = usedWords / words.length;
    const endRatio = Math.min(1, (usedWords + chunk.length) / words.length);
    const startMs = Math.round(segment.startMs + duration * startRatio);
    const rawEndMs = Math.round(segment.startMs + duration * endRatio);
    const endMs = Math.min(segment.endMs, Math.max(startMs + settings.minCueMs, Math.min(startMs + settings.maxCueMs, rawEndMs)));
    cues.push({
      id: createId(),
      videoId: segment.videoId,
      startMs,
      endMs,
      text: chunk.join(' '),
      style: settings.style
    });
    usedWords += chunk.length;
  }
  return cues;
}

function chunkWords(words: string[], wordsPerCue: number, maxCharsPerCue: number) {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const word of words) {
    const next = [...current, word];
    if (current.length && (next.length > wordsPerCue || next.join(' ').length > maxCharsPerCue)) {
      chunks.push(current);
      current = [word];
    } else {
      current = next;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function makeFallbackTranscript(video: VideoProject, text = 'Transcripcion pendiente. Escribi aca el texto real y ajusta los tiempos desde el editor.') {
  const duration = Math.max(video.durationMs || 8000, 4000);
  const chunk = Math.min(duration, 6000);
  const rows: TranscriptSegment[] = [];
  for (let start = 0; start < duration; start += chunk) {
    rows.push({
      id: createId(),
      videoId: video.id,
      startMs: start,
      endMs: Math.min(start + chunk, duration),
      text: rows.length === 0 ? text : 'Nuevo bloque editable de subtitulos.',
      source: 'fallback'
    });
  }
  return rows;
}
