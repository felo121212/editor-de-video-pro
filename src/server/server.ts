import cors from 'cors';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import multer from 'multer';
import path from 'node:path';
import { env } from './env.js';
import { createId, getStore } from './db/store.js';
import { deleteVideoStorage, ensureStorage, ensureVideoDir, resolveMediaPath, sanitizeFileName } from './services/storage.service.js';
import { presentAsset, presentEditorState, presentRender, presentThumbnail, presentVideo } from './services/presenter.js';
import { transcriptToSubtitles } from './services/transcription.service.js';
import { defaultSubtitleStyle, ImageAsset, JobType, SilenceSegment, SubtitleCue, SubtitleGenerationSettings, SubtitleStyle, TimelineEvent, TranscriptSegment } from '../shared/types.js';

const app = express();
const store = getStore();
const upload = multer({
  dest: path.join(env.storageDir, 'tmp', 'incoming'),
  limits: {
    fileSize: env.maxUploadMb * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'video' && isAllowedVideoUpload(file)) return cb(null, true);
    if (file.fieldname === 'asset' && isAllowedImageUpload(file)) return cb(null, true);
    const error = new Error(`Unsupported upload type: ${file.mimetype}`) as Error & { status: number };
    error.status = 400;
    return cb(error);
  }
});

app.use(cors({ origin: env.appOrigin === '*' ? true : env.appOrigin, credentials: true }));
app.use(requireBasicAuth);
app.use('/api', limitMutatingRequests);
app.use(express.json({ limit: '8mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'editor-de-video-pro', storage: env.storageDir, db: env.databaseUrl ? 'mysql' : 'json' });
});

app.get('/media/*', async (req, res, next) => {
  try {
    const wildcard = String((req.params as Record<string, string>)['0'] ?? '');
    const parts = wildcard.split('/').map(decodeURIComponent).filter(Boolean);
    const filePath = resolveMediaPath(parts);
    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos', async (_req, res, next) => {
  try {
    const videos = await store.listVideos();
    res.json({ videos: videos.map(presentVideo) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/videos/upload', upload.single('video'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Missing video file' });
    const title = String(req.body.title || req.file.originalname || 'Nuevo video').trim();
    const tempPath = req.file.path;
    const video = await store.createVideo({ title, originalPath: tempPath });
    const dir = await ensureVideoDir('uploads', video.id);
    const originalName = sanitizeFileName(req.file.originalname || 'video.mp4');
    const finalPath = path.join(dir, originalName);
    await fs.rename(tempPath, finalPath);
    const updated = await store.updateVideo(video.id, { originalPath: finalPath, status: 'uploaded' });
    const job = await store.createJob(video.id, 'ingest');
    res.status(201).json({ video: presentVideo(updated), job });
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id', async (req, res, next) => {
  try {
    const state = await store.getEditorState(req.params.id);
    if (!state) return res.status(404).json({ error: 'Video not found' });
    res.json(presentEditorState(state));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/videos/:id', async (req, res, next) => {
  try {
    await store.deleteVideo(req.params.id);
    await deleteVideoStorage(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/videos/:id/jobs/:type', async (req, res, next) => {
  try {
    const video = await store.getVideo(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const type = normalizeJobType(req.params.type);
    if (!type) return res.status(400).json({ error: 'Unknown job type' });
    const job = await store.createJob(video.id, type, req.body ?? {});
    res.status(201).json({ job });
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs/:id', async (req, res, next) => {
  try {
    const job = await store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id/jobs', async (req, res, next) => {
  try {
    res.json({ jobs: await store.listJobs(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id/silences', async (req, res, next) => {
  try {
    res.json({ silences: await store.getSilences(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/videos/:id/silences', async (req, res, next) => {
  try {
    const rows = sanitizeSilences(req.params.id, req.body.items ?? req.body.silences ?? []);
    res.json({ silences: await store.replaceSilences(req.params.id, rows) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id/transcript', async (req, res, next) => {
  try {
    res.json({ transcript: await store.getTranscript(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/videos/:id/transcript', async (req, res, next) => {
  try {
    const rows = sanitizeTranscript(req.params.id, req.body.items ?? req.body.transcript ?? []);
    res.json({ transcript: await store.replaceTranscript(req.params.id, rows) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id/subtitles', async (req, res, next) => {
  try {
    res.json({ subtitles: await store.getSubtitles(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/videos/:id/subtitles/regenerate', async (req, res, next) => {
  try {
    const video = await store.getVideo(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const transcript = await store.getTranscript(video.id);
    if (!transcript.length) return res.status(400).json({ error: 'Transcript is empty' });
    const settings = sanitizeSubtitleGenerationSettings(req.body ?? {});
    const subtitles = transcriptToSubtitles(transcript, settings);
    res.json({ subtitles: await store.replaceSubtitles(video.id, subtitles), settings });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/videos/:id/subtitles', async (req, res, next) => {
  try {
    const rows = sanitizeSubtitles(req.params.id, req.body.items ?? req.body.subtitles ?? []);
    res.json({ subtitles: await store.replaceSubtitles(req.params.id, rows) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/videos/:id/assets/png', upload.single('asset'), async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const video = await store.getVideo(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (!req.file) return res.status(400).json({ error: 'Missing asset file' });
    const dir = await ensureVideoDir('assets', video.id);
    const fileName = `${Date.now()}-${sanitizeFileName(req.file.originalname || 'asset.png')}`;
    const finalPath = path.join(dir, fileName);
    await fs.rename(req.file.path, finalPath);
    const triggerWords = parseCsv(body.triggerWords ?? body.triggers ?? body.label ?? '');
    const asset = await store.createAsset({
      videoId: video.id,
      label: cleanText(body.label || fileName, 80),
      filePath: finalPath,
      triggerWords,
      position: sanitizePosition({ x: body.x, y: body.y, scale: body.scale }),
      timingMode: 'word_match'
    });
    res.status(201).json({ asset: presentAsset(asset) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id/assets', async (req, res, next) => {
  try {
    const assets = await store.getAssets(req.params.id);
    res.json({ assets: assets.map(presentAsset) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id/waveform', async (req, res, next) => {
  try {
    res.json({ waveform: await store.getWaveform(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id/thumbnails', async (req, res, next) => {
  try {
    const thumbnails = await store.getThumbnails(req.params.id);
    res.json({ thumbnails: thumbnails.map(presentThumbnail) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/assets/:id', async (req, res, next) => {
  try {
    const patch: Partial<ImageAsset> = {};
    if (req.body.label !== undefined) patch.label = cleanText(req.body.label, 80);
    if (req.body.triggerWords !== undefined) patch.triggerWords = Array.isArray(req.body.triggerWords) ? req.body.triggerWords.map((word: unknown) => cleanText(word, 40)).filter(Boolean) : parseCsv(req.body.triggerWords);
    if (req.body.position !== undefined) patch.position = sanitizePosition(req.body.position);
    if (req.body.timingMode !== undefined) patch.timingMode = req.body.timingMode === 'manual' ? 'manual' : 'word_match';
    const asset = await store.updateAsset(req.params.id, patch);
    res.json({ asset: presentAsset(asset) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/assets/:id', async (req, res, next) => {
  try {
    await store.deleteAsset(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id/timeline', async (req, res, next) => {
  try {
    res.json({ timeline: await store.getTimeline(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/videos/:id/timeline', async (req, res, next) => {
  try {
    const rows = sanitizeTimeline(req.params.id, req.body.items ?? req.body.timeline ?? []);
    res.json({ timeline: await store.replaceTimeline(req.params.id, rows) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id/renders', async (req, res, next) => {
  try {
    const renders = await store.listRenders(req.params.id);
    res.json({ renders: renders.map(presentRender) });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.resolve(process.cwd(), 'dist/client')));
app.get('*', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'dist/client/index.html'));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  const message = error instanceof Error ? error.message : 'Unexpected error';
  const status = error instanceof multer.MulterError ? 400 : Number((error as { status?: number }).status ?? 500);
  res.status(status).json({ error: message });
});

await ensureStorage();
await store.migrate();
app.listen(env.port, () => {
  console.log(`Editor de Video Pro API listening on :${env.port}`);
});

function normalizeJobType(type: string): JobType | null {
  const map: Record<string, JobType> = {
    ingest: 'ingest',
    waveform: 'generate_waveform',
    'generate-waveform': 'generate_waveform',
    generate_waveform: 'generate_waveform',
    thumbnails: 'generate_thumbnails',
    'generate-thumbnails': 'generate_thumbnails',
    generate_thumbnails: 'generate_thumbnails',
    'detect-silence': 'detect_silence',
    detect_silence: 'detect_silence',
    transcribe: 'transcribe',
    render: 'render'
  };
  return map[type] ?? null;
}

function isAllowedVideoUpload(file: Express.Multer.File) {
  const ext = path.extname(file.originalname ?? '').toLowerCase();
  return file.mimetype.startsWith('video/') || ['.mp4', '.mov', '.m4v', '.webm', '.mkv'].includes(ext);
}

function isAllowedImageUpload(file: Express.Multer.File) {
  const ext = path.extname(file.originalname ?? '').toLowerCase();
  return ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype) || ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
}

function parseCsv(value: unknown) {
  return String(value)
    .split(',')
    .map((item) => cleanText(item, 40))
    .filter(Boolean);
}

function sanitizeSilences(videoId: string, rows: unknown): SilenceSegment[] {
  return asArray(rows).map((row) => ({
    id: row.id || createId(),
    videoId,
    startMs: clampNumber(row.startMs ?? row.start_ms, 0, 24 * 60 * 60 * 1000, 0),
    endMs: clampNumber(row.endMs ?? row.end_ms, 0, 24 * 60 * 60 * 1000, 0),
    durationMs: clampNumber(row.durationMs ?? row.duration_ms ?? Math.max(0, Number(row.endMs ?? 0) - Number(row.startMs ?? 0)), 0, 24 * 60 * 60 * 1000, 0),
    action: row.action === 'keep' ? 'keep' as const : 'cut' as const
  })).filter((row) => row.endMs > row.startMs);
}

function sanitizeTranscript(videoId: string, rows: unknown): TranscriptSegment[] {
  return asArray(rows).map((row) => ({
    id: row.id || createId(),
    videoId,
    startMs: clampNumber(row.startMs ?? row.start_ms, 0, 24 * 60 * 60 * 1000, 0),
    endMs: clampNumber(row.endMs ?? row.end_ms, 0, 24 * 60 * 60 * 1000, 0),
    text: cleanText(row.text, 1200),
    source: row.source === 'openai' || row.source === 'whisper_local' || row.source === 'fallback' ? row.source : 'manual'
  })).filter((row) => row.endMs > row.startMs && row.text);
}

function sanitizeSubtitles(videoId: string, rows: unknown): SubtitleCue[] {
  return asArray(rows).map((row) => ({
    id: row.id || createId(),
    videoId,
    startMs: clampNumber(row.startMs ?? row.start_ms, 0, 24 * 60 * 60 * 1000, 0),
    endMs: clampNumber(row.endMs ?? row.end_ms, 0, 24 * 60 * 60 * 1000, 0),
    text: cleanText(row.text, 400),
    style: sanitizeSubtitleStyle(row.style)
  })).filter((row) => row.endMs > row.startMs && row.text);
}

function sanitizeTimeline(videoId: string, rows: unknown): TimelineEvent[] {
  return asArray(rows).map((row) => ({
    id: row.id || createId(),
    videoId,
    type: sanitizeEventType(row.type),
    startMs: clampNumber(row.startMs ?? row.start_ms, 0, 24 * 60 * 60 * 1000, 0),
    endMs: clampNumber(row.endMs ?? row.end_ms, 0, 24 * 60 * 60 * 1000, 0),
    enabled: row.enabled !== false,
    payload: sanitizePayload(row.type, row.payload)
  })).filter((row) => row.endMs > row.startMs);
}

function requireBasicAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!env.authPassword || req.path === '/health') return next();
  const header = req.headers.authorization ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return requestAuth(res);
  const [username, password] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  if (safeEqual(username, env.authUsername) && safeEqual(password, env.authPassword)) return next();
  return requestAuth(res);
}

function requestAuth(res: express.Response) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Editor de Video Pro"');
  return res.status(401).json({ error: 'Authentication required' });
}

function safeEqual(value: string | undefined, expected: string) {
  const left = Buffer.from(value ?? '');
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function limitMutatingRequests(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > 80) return res.status(429).json({ error: 'Too many requests' });
  return next();
}

function asArray(rows: unknown): Record<string, any>[] {
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, any> => Boolean(row) && typeof row === 'object') : [];
}

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function sanitizePosition(value: unknown) {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    x: clampNumber(source.x, 0, 1, 0.5),
    y: clampNumber(source.y, 0, 1, 0.24),
    scale: clampNumber(source.scale, 0.25, 4, 1)
  };
}

function sanitizeSubtitleStyle(value: unknown): SubtitleStyle {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const position: SubtitleStyle['position'] = source.position === 'top' || source.position === 'middle' ? source.position : 'bottom';
  const preset: SubtitleStyle['preset'] = source.preset === 'yellow' || source.preset === 'neon' || source.preset === 'pill' || source.preset === 'minimal'
    ? source.preset
    : 'bold';
  return {
    ...defaultSubtitleStyle,
    preset,
    fontFamily: cleanText(source.fontFamily ?? defaultSubtitleStyle.fontFamily, 40) || defaultSubtitleStyle.fontFamily,
    fontSize: clampNumber(source.fontSize, 16, 96, defaultSubtitleStyle.fontSize),
    primaryColor: cleanHexColor(source.primaryColor, defaultSubtitleStyle.primaryColor),
    outlineColor: cleanHexColor(source.outlineColor, defaultSubtitleStyle.outlineColor),
    backColor: cleanHexColor(source.backColor, defaultSubtitleStyle.backColor),
    outlineWidth: clampNumber(source.outlineWidth, 0, 8, defaultSubtitleStyle.outlineWidth),
    shadow: clampNumber(source.shadow, 0, 8, defaultSubtitleStyle.shadow),
    box: source.box === true,
    bold: source.bold !== false,
    uppercase: source.uppercase === true,
    position
  };
}

function sanitizeSubtitleGenerationSettings(value: unknown): SubtitleGenerationSettings {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    wordsPerCue: clampNumber(source.wordsPerCue, 2, 9, 5),
    maxCharsPerCue: clampNumber(source.maxCharsPerCue, 10, 80, 34),
    minCueMs: clampNumber(source.minCueMs, 350, 3000, 700),
    maxCueMs: clampNumber(source.maxCueMs, 900, 7000, 2400),
    style: sanitizeSubtitleStyle(source.style)
  };
}

function cleanHexColor(value: unknown, fallback: string) {
  const text = String(value ?? '');
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback;
}

function sanitizeEventType(value: unknown): TimelineEvent['type'] {
  if (value === 'cut' || value === 'zoom' || value === 'image_overlay' || value === 'subtitle_style') return value;
  const error = new Error('Invalid timeline event type') as Error & { status: number };
  error.status = 400;
  throw error;
}

function sanitizePayload(type: unknown, payload: unknown) {
  const source = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (type === 'zoom') return { scale: clampNumber(source.scale, 1, 2.5, 1.16) };
  if (type === 'image_overlay') return { assetId: cleanText(source.assetId, 32) };
  if (type === 'cut') return { source: cleanText(source.source, 80), durationMs: clampNumber(source.durationMs, 0, 60 * 60 * 1000, 0) };
  return source;
}
