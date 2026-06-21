import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { createId } from '../db/store.js';
import { concatSegments, ffprobe, runCommand, trimSegment } from './ffmpeg.service.js';
import { ensureVideoDir } from './storage.service.js';
import { msToAssTime, formatSeconds } from '../utils/time.js';
import {
  defaultSubtitleStyle,
  EditorState,
  ImageAsset,
  SilenceSegment,
  SubtitleCue,
  SubtitleStyle,
  TimelineEvent,
  TranscriptSegment,
  VideoProject
} from '../../shared/types.js';

interface KeepSegment {
  startMs: number;
  endMs: number;
}

interface OverlayEvent {
  asset: ImageAsset;
  startMs: number;
  endMs: number;
}

interface OutputPreset {
  aspectRatio: '9:16' | '4:5' | '1:1' | '16:9';
  width: number;
  height: number;
}

export async function renderVideo(state: EditorState, jobId: string, options: Record<string, unknown> = {}) {
  const renderDir = await ensureVideoDir('renders', state.video.id);
  const tmpBaseDir = await ensureVideoDir('tmp', state.video.id);
  const tmpDir = path.join(tmpBaseDir, jobId);
  await fs.mkdir(tmpDir, { recursive: true });
  const keeps = buildKeepSegments(state.video.durationMs, state.silences);
  const outputPreset = outputPresetFor(options.aspectRatio);
  const cutPath = path.join(tmpDir, `${jobId}-cut.mp4`);
  const framedPath = path.join(tmpDir, `${jobId}-framed.mp4`);
  const zoomedPath = path.join(tmpDir, `${jobId}-zoomed.mp4`);
  const subtitlePath = path.join(tmpDir, `${jobId}.ass`);
  const subtitledPath = path.join(tmpDir, `${jobId}-subtitled.mp4`);
  const outputPath = path.join(renderDir, `render-${Date.now()}.mp4`);

  try {
    const cutInput = await renderCuts(state.video.originalPath, cutPath, tmpDir, jobId, keeps, state.video.durationMs);
    const framedInput = await conformToOutput(cutInput, framedPath, outputPreset);
    const framedProbe = outputPreset ? { width: outputPreset.width, height: outputPreset.height } : await ffprobe(framedInput);
    const subtitleWidth = framedProbe.width || state.video.width || 1080;
    const subtitleHeight = framedProbe.height || state.video.height || 1920;
    const zoomedInput = await renderZooms(framedInput, zoomedPath, state, keeps, subtitleWidth, subtitleHeight);
    await writeAssFile(subtitlePath, state.subtitles, keeps, subtitleWidth, subtitleHeight);

    await runCommand(env.ffmpegPath, [
      '-y',
      '-i',
      zoomedInput,
      '-vf',
      `ass='${escapeFilterPath(subtitlePath)}'`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-c:a',
      'aac',
      subtitledPath
    ]);

    await renderOverlays(subtitledPath, outputPath, state, keeps);
    return outputPath;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function conformToOutput(inputPath: string, outputPath: string, preset: OutputPreset | null) {
  if (!preset) return inputPath;
  await runCommand(env.ffmpegPath, [
    '-y',
    '-i',
    inputPath,
    '-vf',
    `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=increase,crop=${preset.width}:${preset.height},setsar=1`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    outputPath
  ]);
  return outputPath;
}

function buildKeepSegments(durationMs: number, silences: SilenceSegment[]) {
  const rawCuts = silences
    .filter((segment) => segment.action === 'cut')
    .map((segment) => ({
      startMs: Math.max(0, Math.min(durationMs, segment.startMs)),
      endMs: Math.max(0, Math.min(durationMs, segment.endMs))
    }))
    .filter((segment) => segment.endMs > segment.startMs + 80)
    .sort((a, b) => a.startMs - b.startMs);
  const cuts: KeepSegment[] = [];
  for (const cut of rawCuts) {
    const previous = cuts[cuts.length - 1];
    if (previous && cut.startMs <= previous.endMs + 60) {
      previous.endMs = Math.max(previous.endMs, cut.endMs);
    } else {
      cuts.push({ ...cut });
    }
  }
  const keeps: KeepSegment[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.startMs > cursor + 120) keeps.push({ startMs: cursor, endMs: cut.startMs });
    cursor = Math.max(cursor, cut.endMs);
  }
  if (durationMs > cursor + 120) keeps.push({ startMs: cursor, endMs: durationMs });
  return keeps.length ? keeps : [{ startMs: 0, endMs: durationMs }];
}

function outputPresetFor(value: unknown): OutputPreset | null {
  if (value === '9:16') return { aspectRatio: '9:16', width: 1080, height: 1920 };
  if (value === '4:5') return { aspectRatio: '4:5', width: 1080, height: 1350 };
  if (value === '1:1') return { aspectRatio: '1:1', width: 1080, height: 1080 };
  if (value === '16:9') return { aspectRatio: '16:9', width: 1920, height: 1080 };
  return null;
}

async function renderCuts(inputPath: string, outputPath: string, tmpDir: string, jobId: string, keeps: KeepSegment[], durationMs: number) {
  if (keeps.length === 1 && keeps[0].startMs === 0 && keeps[0].endMs >= durationMs - 80) return inputPath;
  const listFile = path.join(tmpDir, `${jobId}-concat.txt`);
  const lines: string[] = [];
  for (let index = 0; index < keeps.length; index += 1) {
    const clip = path.join(tmpDir, `${jobId}-clip-${index}.mp4`);
    await trimSegment(inputPath, clip, keeps[index].startMs, keeps[index].endMs);
    lines.push(`file '${clip.replaceAll('\\', '/')}'`);
  }
  await fs.writeFile(listFile, lines.join('\n'));
  await concatSegments(listFile, outputPath);
  return outputPath;
}

function remapMs(ms: number, keeps: KeepSegment[]) {
  let rendered = 0;
  for (const keep of keeps) {
    if (ms >= keep.startMs && ms <= keep.endMs) return rendered + (ms - keep.startMs);
    rendered += keep.endMs - keep.startMs;
  }
  return null;
}

async function writeAssFile(filePath: string, subtitles: SubtitleCue[], keeps: KeepSegment[], width: number, height: number) {
  const events = subtitles
    .map((cue) => {
      const start = remapMs(cue.startMs, keeps);
      const end = remapMs(cue.endMs, keeps);
      if (start === null || end === null || end <= start) return null;
      return { ...cue, startMs: start, endMs: end, style: normalizeSubtitleStyle(cue.style) };
    })
    .filter(Boolean) as SubtitleCue[];

  const styleNames = new Map<string, { name: string; style: SubtitleStyle }>();
  for (const cue of events) {
    const key = JSON.stringify(cue.style);
    if (!styleNames.has(key)) styleNames.set(key, { name: `Caption${styleNames.size + 1}`, style: cue.style });
  }
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${Math.max(2, Math.round(width))}`,
    `PlayResY: ${Math.max(2, Math.round(height))}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...Array.from(styleNames.values()).map(({ name, style }) => assStyleLine(name, style, width, height)),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events.map((cue) => {
      const key = JSON.stringify(cue.style);
      const styleName = styleNames.get(key)?.name ?? 'Caption1';
      const text = (cue.style.uppercase ? cue.text.toUpperCase() : cue.text).replace(/\r?\n/g, '\\N').replace(/[{}]/g, '');
      return `Dialogue: 0,${msToAssTime(cue.startMs)},${msToAssTime(cue.endMs)},${styleName},,0,0,0,,${text}`;
    })
  ];
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
}

function assStyleLine(name: string, style: SubtitleStyle, width: number, height: number) {
  const alignment = style.position === 'top' ? 8 : style.position === 'middle' ? 5 : 2;
  const borderStyle = style.box ? 3 : 1;
  const backAlpha = style.box ? 32 : 255;
  const marginX = Math.round(Math.max(24, width * 0.065));
  const marginV = Math.round(Math.max(24, height * (style.position === 'bottom' ? 0.085 : 0.07)));
  return [
    'Style:',
    [
      name,
      style.fontFamily || 'Arial',
      Math.round(style.fontSize),
      toAssColor(style.primaryColor, 0),
      '&H000000FF',
      toAssColor(style.outlineColor, 0),
      toAssColor(style.backColor, backAlpha),
      style.bold ? -1 : 0,
      0,
      0,
      0,
      100,
      100,
      0,
      0,
      borderStyle,
      Number(style.outlineWidth.toFixed(1)),
      Number(style.shadow.toFixed(1)),
      alignment,
      marginX,
      marginX,
      marginV,
      1
    ].join(',')
  ].join(' ');
}

async function renderZooms(inputPath: string, outputPath: string, state: EditorState, keeps: KeepSegment[], width: number, height: number) {
  const zooms = state.timeline
    .filter((event) => event.type === 'zoom' && event.enabled)
    .map((event) => remapTimelineEvent(event, keeps))
    .filter(Boolean) as TimelineEvent[];

  if (!zooms.length || width <= 0 || height <= 0) return inputPath;

  const scaleExpr = nestedBetweenExpr(zooms, 'scale', 1.16);
  await runCommand(env.ffmpegPath, [
    '-y',
    '-i',
    inputPath,
    '-vf',
    `scale=w='trunc(iw*(${scaleExpr})/2)*2':h='trunc(ih*(${scaleExpr})/2)*2':eval=frame,crop=${width}:${height}:(in_w-${width})/2:(in_h-${height})/2`,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-c:a',
    'aac',
    outputPath
  ]);
  return outputPath;
}

async function renderOverlays(inputPath: string, outputPath: string, state: EditorState, keeps: KeepSegment[]) {
  const overlays = buildOverlayEvents(state.assets, state.transcript, state.timeline, keeps);

  if (!overlays.length) {
    await runCommand(env.ffmpegPath, ['-y', '-i', inputPath, '-c', 'copy', outputPath]);
    return;
  }

  const args = ['-y', '-i', inputPath];
  for (const event of overlays) args.push('-i', event.asset.filePath);

  const filters: string[] = [];
  let current = '[0:v]';

  overlays.forEach((event, index) => {
    const inputIndex = index + 1;
    const scaled = `[asset${index}]`;
    const out = `[v${index}]`;
    const renderedStart = remapMs(event.startMs, keeps);
    const renderedEnd = remapMs(event.endMs, keeps);
    if (renderedStart === null || renderedEnd === null) return;
    const size = Math.max(96, Math.round(240 * (event.asset.position.scale || 1)));
    filters.push(`[${inputIndex}:v]scale=${size}:-1${scaled}`);
    filters.push(
      `${current}${scaled}overlay=x='main_w*${event.asset.position.x}-overlay_w/2':y='main_h*${event.asset.position.y}-overlay_h/2':enable='between(t,${formatSeconds(renderedStart)},${formatSeconds(renderedEnd)})'${out}`
    );
    current = out;
  });

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    current,
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-c:a',
    'aac',
    outputPath
  );
  await runCommand(env.ffmpegPath, args);
}

function buildOverlayEvents(
  assets: ImageAsset[],
  transcript: TranscriptSegment[],
  timeline: TimelineEvent[],
  keeps: KeepSegment[]
): OverlayEvent[] {
  const manual = timeline
    .filter((event) => event.type === 'image_overlay' && event.enabled)
    .map((event) => {
      const asset = assets.find((item) => item.id === event.payload.assetId);
      if (!asset) return null;
      return { asset, startMs: event.startMs, endMs: event.endMs };
    })
    .filter(Boolean) as OverlayEvent[];

  const fromWords: OverlayEvent[] = [];
  for (const asset of assets.filter((item) => item.timingMode === 'word_match')) {
    for (const segment of transcript) {
      const lower = segment.text.toLowerCase();
      if (!asset.triggerWords.some((word) => lower.includes(word.toLowerCase()))) continue;
      fromWords.push({
        asset,
        startMs: segment.startMs,
        endMs: Math.min(segment.endMs + 900, segment.startMs + 2400)
      });
    }
  }
  return [...manual, ...fromWords]
    .filter((event) => remapMs(event.startMs, keeps) !== null)
    .slice(0, 24);
}

function nestedBetweenExpr(events: TimelineEvent[], key: string, fallback: number) {
  return events.reduceRight((acc, event) => {
    const value = Number(event.payload[key] ?? fallback);
    return `if(between(t,${formatSeconds(event.startMs)},${formatSeconds(event.endMs)}),${value},${acc})`;
  }, '1');
}

function remapTimelineEvent(event: TimelineEvent, keeps: KeepSegment[]) {
  const startMs = remapMs(event.startMs, keeps);
  const endMs = remapMs(event.endMs, keeps);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return { ...event, startMs, endMs };
}

function normalizeSubtitleStyle(style: Partial<SubtitleStyle> | undefined): SubtitleStyle {
  const preset: SubtitleStyle['preset'] = style?.preset === 'yellow' || style?.preset === 'neon' || style?.preset === 'pill' || style?.preset === 'minimal'
    ? style.preset
    : 'bold';
  return {
    ...defaultSubtitleStyle,
    ...style,
    preset,
    fontSize: finiteNumber(style?.fontSize, defaultSubtitleStyle.fontSize),
    outlineWidth: finiteNumber(style?.outlineWidth, defaultSubtitleStyle.outlineWidth),
    shadow: finiteNumber(style?.shadow, defaultSubtitleStyle.shadow),
    box: style?.box === true,
    position: style?.position === 'top' || style?.position === 'middle' ? style.position : 'bottom'
  };
}

function toAssColor(hex: string, alpha = 0) {
  const clean = hex.replace('#', '').padEnd(6, '0');
  const alphaHex = Math.round(Math.min(255, Math.max(0, alpha))).toString(16).padStart(2, '0').toUpperCase();
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${alphaHex}${b}${g}${r}`;
}

function escapeFilterPath(filePath: string) {
  return filePath.replaceAll('\\', '/').replace(/^([A-Za-z]):/, '$1\\:').replaceAll("'", "\\'");
}

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
