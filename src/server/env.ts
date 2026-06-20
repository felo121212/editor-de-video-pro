import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

const root = process.cwd();

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8787),
  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  databaseUrl: process.env.DATABASE_URL ?? '',
  storageDir: path.resolve(root, process.env.STORAGE_DIR ?? './storage'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? '',
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
  ffmpegTimeoutMs: Number(process.env.FFMPEG_TIMEOUT_MS ?? 20 * 60 * 1000),
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  openAiTranscribeModel: process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-transcribe',
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 700),
  authUsername: process.env.AUTH_USERNAME ?? 'metamize',
  authPassword: process.env.AUTH_PASSWORD ?? '',
  runWorkerInWeb: process.env.RUN_WORKER_IN_WEB !== 'false',
  staleJobMs: Number(process.env.STALE_JOB_MS ?? 15 * 60 * 1000),
  maxJobAttempts: Number(process.env.MAX_JOB_ATTEMPTS ?? 3)
};
