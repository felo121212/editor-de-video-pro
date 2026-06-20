import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { createId } from '../db/store.js';
import { extractAudio } from './ffmpeg.service.js';
import { ensureVideoDir } from './storage.service.js';
import { defaultSubtitleStyle, SubtitleCue, TranscriptSegment, VideoProject } from '../../shared/types.js';

interface OpenAiSegment {
  start?: number;
  end?: number;
  text?: string;
}

export async function transcribe(video: VideoProject) {
  const audioDir = await ensureVideoDir('tmp', video.id);
  const audioPath = path.join(audioDir, 'audio.mp3');
  await extractAudio(video.originalPath, audioPath);

  if (!env.openAiApiKey) {
    const fallback = makeFallbackTranscript(video);
    return { transcript: fallback, subtitles: transcriptToSubtitles(fallback), warning: 'OPENAI_API_KEY is not set; created editable placeholder transcript.' };
  }

  const audio = await fs.readFile(audioPath);
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', env.openAiTranscribeModel);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.openAiApiKey}`
    },
    body: form
  });

  if (!response.ok) {
    const text = await response.text();
    const fallback = makeFallbackTranscript(video, `Transcripción falló: ${response.status}. Editá este texto manualmente.`);
    return { transcript: fallback, subtitles: transcriptToSubtitles(fallback), warning: text };
  }

  const data = await response.json();
  const segments = Array.isArray(data.segments) ? (data.segments as OpenAiSegment[]) : [];
  const transcript = segments.length
    ? segments.map((segment) => ({
        id: createId(),
        videoId: video.id,
        startMs: Math.round(Number(segment.start ?? 0) * 1000),
        endMs: Math.round(Number(segment.end ?? segment.start ?? 0) * 1000),
        text: String(segment.text ?? '').trim(),
        source: 'openai' as const
      })).filter((segment) => segment.text)
    : makeFallbackTranscript(video, String(data.text ?? 'Transcripción lista para editar.'));

  return { transcript, subtitles: transcriptToSubtitles(transcript), warning: null };
}

export function transcriptToSubtitles(transcript: TranscriptSegment[]): SubtitleCue[] {
  return transcript.map((segment) => ({
    id: createId(),
    videoId: segment.videoId,
    startMs: segment.startMs,
    endMs: Math.max(segment.endMs, segment.startMs + 1200),
    text: segment.text,
    style: defaultSubtitleStyle
  }));
}

function makeFallbackTranscript(video: VideoProject, text = 'Transcripción pendiente. Escribí acá el texto real y ajustá los tiempos desde el editor.') {
  const duration = Math.max(video.durationMs || 8000, 4000);
  const chunk = Math.min(duration, 6000);
  const rows: TranscriptSegment[] = [];
  for (let start = 0; start < duration; start += chunk) {
    rows.push({
      id: createId(),
      videoId: video.id,
      startMs: start,
      endMs: Math.min(start + chunk, duration),
      text: rows.length === 0 ? text : 'Nuevo bloque editable de subtítulos.',
      source: 'fallback'
    });
  }
  return rows;
}

