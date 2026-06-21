import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { formatSeconds } from '../utils/time.js';
import { SilenceSegment, VideoThumbnail, WaveformPoint } from '../../shared/types.js';
import { createId } from '../db/store.js';

export interface ProbeResult {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
  timeoutMs?: number;
  logLimit?: number;
}

export function runCommand(command: string, args: string[], onStderr?: (chunk: string) => void, options: RunCommandOptions = {}) {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const logLimit = options.logLimit ?? 240_000;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? env.ffmpegTimeoutMs}ms`));
    }, options.timeoutMs ?? env.ffmpegTimeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = appendCapped(stdout, chunk.toString(), logLimit);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = appendCapped(stderr, text, logLimit);
      onStderr?.(text);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}\n${stderr}`));
    });
  });
}

function appendCapped(current: string, next: string, limit: number) {
  const combined = current + next;
  return combined.length > limit ? combined.slice(combined.length - limit) : combined;
}

export async function ffprobe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await runCommand(env.ffprobePath, [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    filePath
  ]);
  const data = JSON.parse(stdout);
  const videoStream = data.streams?.find((stream: any) => stream.codec_type === 'video') ?? {};
  const duration = Number(data.format?.duration ?? videoStream.duration ?? 0);
  const rate = String(videoStream.avg_frame_rate ?? videoStream.r_frame_rate ?? '30/1').split('/');
  const fps = Number(rate[0]) / Number(rate[1] || 1);
  return {
    durationMs: Math.round(duration * 1000),
    width: Number(videoStream.width ?? 0),
    height: Number(videoStream.height ?? 0),
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30
  };
}

export async function createProxy(inputPath: string, outputPath: string) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand(env.ffmpegPath, [
    '-y',
    '-i',
    inputPath,
    '-vf',
    'scale=-2:min(720\\,ih)',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    outputPath
  ]);
}

export async function createWaveform(inputPath: string, pcmPath: string, videoId: string, durationMs: number, sampleCount = 180) {
  await fs.mkdir(path.dirname(pcmPath), { recursive: true });
  try {
    await runCommand(env.ffmpegPath, [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '8000',
      '-acodec',
      'pcm_s16le',
      '-f',
      's16le',
      pcmPath
    ]);
  } catch {
    return emptyWaveform(videoId, durationMs, sampleCount);
  }

  const buffer = await fs.readFile(pcmPath);
  if (buffer.length < 2) return emptyWaveform(videoId, durationMs, sampleCount);
  const sampleTotal = Math.floor(buffer.length / 2);
  const bucketSize = Math.max(1, Math.ceil(sampleTotal / sampleCount));
  const rows: WaveformPoint[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const startSample = index * bucketSize;
    const endSample = Math.min(sampleTotal, startSample + bucketSize);
    let peak = 0;
    for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(buffer.readInt16LE(sampleIndex * 2)) / 32768);
    }
    const startMs = Math.round((index / sampleCount) * durationMs);
    const endMs = Math.round(((index + 1) / sampleCount) * durationMs);
    rows.push({
      id: createId(),
      videoId,
      startMs,
      endMs,
      amplitude: Math.min(1, Math.max(0, Number(peak.toFixed(4))))
    });
  }
  return rows;
}

export async function createThumbnails(
  inputPath: string,
  outputDir: string,
  videoId: string,
  durationMs: number,
  sourceWidth: number,
  sourceHeight: number,
  count = 12
) {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  const height = sourceWidth > 0 && sourceHeight > 0 ? Math.max(2, Math.round(160 * (sourceHeight / sourceWidth))) : 90;
  const rows: VideoThumbnail[] = [];
  for (let index = 0; index < count; index += 1) {
    const timeMs = Math.max(0, Math.min(Math.max(0, durationMs - 1), Math.round(durationMs * ((index + 0.5) / count))));
    const filePath = path.join(outputDir, `thumb-${String(index + 1).padStart(2, '0')}.jpg`);
    try {
      await runCommand(env.ffmpegPath, [
        '-y',
        '-ss',
        formatSeconds(timeMs),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=160:-2',
        '-q:v',
        '5',
        filePath
      ]);
      rows.push({
        id: createId(),
        videoId,
        timeMs,
        filePath,
        width: 160,
        height
      });
    } catch {
      // A broken frame should not fail the whole editor state. The next frame often succeeds.
    }
  }
  return rows;
}

function emptyWaveform(videoId: string, durationMs: number, sampleCount: number) {
  return Array.from({ length: sampleCount }, (_, index): WaveformPoint => ({
    id: createId(),
    videoId,
    startMs: Math.round((index / sampleCount) * durationMs),
    endMs: Math.round(((index + 1) / sampleCount) * durationMs),
    amplitude: 0
  }));
}

export interface DetectSilenceOptions {
  noiseDb?: number;
  minDurationSec?: number;
  durationMs?: number;
}

export async function extractAudio(inputPath: string, outputPath: string) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand(env.ffmpegPath, [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'mp3',
    outputPath
  ]);
}

export async function detectSilence(inputPath: string, videoId: string, options: DetectSilenceOptions = {}) {
  const noiseDb = clamp(options.noiseDb ?? env.silenceNoiseDb, -80, -10);
  const minDurationSec = clamp(options.minDurationSec ?? env.silenceMinDurationSec, 0.12, 3);
  const filter = `silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`;
  const { stderr } = await runCommand(env.ffmpegPath, ['-hide_banner', '-i', inputPath, '-af', filter, '-f', 'null', '-']);

  const events = parseSilenceLog(stderr);
  const rows: SilenceSegment[] = [];
  for (const event of events) {
    const startMs = Math.round(event.startSec * 1000);
    const endMs = Math.round(event.endSec * 1000);
    if (endMs - startMs < Math.max(120, minDurationSec * 1000 * 0.8)) continue;
    rows.push({
      id: createId(),
      videoId,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      action: 'cut'
    });
  }
  return rows;
}

function parseSilenceLog(stderr: string) {
  const rows: Array<{ startSec: number; endSec: number; durationSec: number }> = [];
  let currentStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*([0-9.]+)/.exec(line);
    if (start) {
      currentStart = Number(start[1]);
      continue;
    }
    const end = /silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/.exec(line);
    if (end) {
      const endSec = Number(end[1]);
      const durationSec = Number(end[2]);
      const startSec = currentStart ?? Math.max(0, endSec - durationSec);
      if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) {
        rows.push({ startSec, endSec, durationSec });
      }
      currentStart = null;
    }
  }
  return rows;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export async function trimSegment(inputPath: string, outputPath: string, startMs: number, endMs: number) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand(env.ffmpegPath, [
    '-y',
    '-ss',
    formatSeconds(startMs),
    '-i',
    inputPath,
    '-t',
    formatSeconds(Math.max(1, endMs - startMs)),
    '-vf',
    'scale=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-c:a',
    'aac',
    '-avoid_negative_ts',
    'make_zero',
    outputPath
  ]);
}

export async function concatSegments(listFile: string, outputPath: string) {
  await runCommand(env.ffmpegPath, [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-c',
    'copy',
    outputPath
  ]);
}
