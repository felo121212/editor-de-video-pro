import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

const root = process.cwd();
const storageDir = path.resolve(root, process.env.STORAGE_DIR ?? './storage');

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8787),
  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  databaseUrl: process.env.DATABASE_URL ?? '',
  storageDir,
  jsonDbPath: process.env.JSON_DB_PATH ? path.resolve(root, process.env.JSON_DB_PATH) : path.join(storageDir, '.data', 'dev-db.json'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? '',
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
  ffmpegTimeoutMs: Number(process.env.FFMPEG_TIMEOUT_MS ?? 20 * 60 * 1000),
  silenceNoiseDb: Number(process.env.SILENCE_NOISE_DB ?? -35),
  silenceMinDurationSec: Number(process.env.SILENCE_MIN_DURATION_SEC ?? 0.35),
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  transcriptionApiKey: process.env.TRANSCRIPTION_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
  transcriptionApiUrl: process.env.TRANSCRIPTION_API_URL ?? 'https://api.openai.com/v1/audio/transcriptions',
  transcriptionModel: process.env.TRANSCRIPTION_MODEL ?? process.env.OPENAI_TRANSCRIBE_MODEL ?? 'whisper-1',
  transcriptionLanguage: process.env.TRANSCRIPTION_LANGUAGE ?? 'es',
  transcriptionPrompt: process.env.TRANSCRIPTION_PROMPT ?? 'Spanish / Argentine Spanish. Marketing, ecommerce, Meta Ads, ROAS, CPA, campañas, ventas.',
  openAiTranscribeModel: process.env.OPENAI_TRANSCRIBE_MODEL ?? 'whisper-1',
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 700),
  authUsername: process.env.AUTH_USERNAME ?? 'metamize',
  authPassword: process.env.AUTH_PASSWORD ?? '',
  runWorkerInWeb: process.env.RUN_WORKER_IN_WEB !== 'false',
  staleJobMs: Number(process.env.STALE_JOB_MS ?? 15 * 60 * 1000),
  maxJobAttempts: Number(process.env.MAX_JOB_ATTEMPTS ?? 3)
};
