import path from 'node:path';
import { env } from '../server/env.js';
import { getStore } from '../server/db/store.js';
import { createProxy, createThumbnails, createWaveform, detectSilence, ffprobe } from '../server/services/ffmpeg.service.js';
import { ensureStorage, ensureVideoDir } from '../server/services/storage.service.js';
import { transcribe } from '../server/services/transcription.service.js';
import { renderVideo } from '../server/services/render.service.js';

const store = getStore();

await ensureStorage();
await store.migrate();
console.log(`Editor de Video Pro worker started as ${env.workerId}`);

while (true) {
  await store.requeueStaleJobs(env.staleJobMs, env.maxJobAttempts);
  const job = await store.claimNextJob(env.workerId);
  if (!job) {
    await sleep(1400);
    continue;
  }

  try {
    await store.updateJob(job.id, { progress: 5 });
    const video = await store.getVideo(job.videoId);
    if (!video) throw new Error('Video not found for job');
    await store.updateVideo(video.id, { status: 'processing' });

    if (job.type === 'ingest') {
      const probe = await ffprobe(video.originalPath);
      await store.updateJob(job.id, { progress: 35, result: { probe } });
      const proxyDir = await ensureVideoDir('proxies', video.id);
      const proxyPath = path.join(proxyDir, 'proxy-720p.mp4');
      await createProxy(video.originalPath, proxyPath);
      await store.updateVideo(video.id, { ...probe, proxyPath, status: 'ready' });
      await store.createJob(video.id, 'generate_waveform');
      await store.createJob(video.id, 'generate_thumbnails');
      await store.updateJob(job.id, { status: 'done', progress: 100, result: { probe, proxyPath, nextJobs: ['generate_waveform', 'generate_thumbnails'] } });
      continue;
    }

    if (job.type === 'generate_waveform') {
      const durationMs = video.durationMs || (await ffprobe(video.originalPath)).durationMs;
      const tmpDir = await ensureVideoDir('tmp', video.id);
      const pcmPath = path.join(tmpDir, 'waveform.pcm');
      await store.updateJob(job.id, { progress: 35 });
      const rows = await createWaveform(video.originalPath, pcmPath, video.id, durationMs, 180);
      await store.replaceWaveform(video.id, rows);
      await store.updateVideo(video.id, { status: 'ready' });
      await store.updateJob(job.id, { status: 'done', progress: 100, result: { points: rows.length } });
      continue;
    }

    if (job.type === 'generate_thumbnails') {
      const probe = video.durationMs && video.width ? video : await ffprobe(video.originalPath);
      const outputDir = await ensureVideoDir('thumbnails', video.id);
      await store.updateJob(job.id, { progress: 35 });
      const rows = await createThumbnails(video.originalPath, outputDir, video.id, probe.durationMs, probe.width, probe.height, 12);
      await store.replaceThumbnails(video.id, rows);
      await store.updateVideo(video.id, { status: 'ready' });
      await store.updateJob(job.id, { status: 'done', progress: 100, result: { thumbnails: rows.length } });
      continue;
    }

    if (job.type === 'detect_silence') {
      const settings = {
        noiseDb: numberFromPayload(job.payload.noiseDb, env.silenceNoiseDb),
        minDurationSec: numberFromPayload(job.payload.minDurationSec, env.silenceMinDurationSec),
        durationMs: video.durationMs
      };
      const rows = await detectSilence(video.originalPath, video.id, settings);
      await store.replaceSilences(video.id, rows);
      const existingTimeline = await store.getTimeline(video.id);
      const nonCuts = existingTimeline.filter((event) => event.type !== 'cut');
      await store.replaceTimeline(video.id, [
        ...nonCuts,
        ...rows.map((row) => ({
          id: row.id,
          videoId: video.id,
          type: 'cut' as const,
          startMs: row.startMs,
          endMs: row.endMs,
          enabled: row.action === 'cut',
          payload: { source: 'ffmpeg_silencedetect', durationMs: row.durationMs }
        }))
      ]);
      await store.updateVideo(video.id, { status: 'ready' });
      await store.updateJob(job.id, { status: 'done', progress: 100, result: { count: rows.length, settings } });
      continue;
    }

    if (job.type === 'transcribe') {
      const result = await transcribe(video);
      await store.replaceTranscript(video.id, result.transcript);
      await store.replaceSubtitles(video.id, result.subtitles);
      await store.updateVideo(video.id, { status: 'ready' });
      await store.updateJob(job.id, { status: 'done', progress: 100, result: { segments: result.transcript.length, warning: result.warning } });
      continue;
    }

    if (job.type === 'render') {
      const state = await store.getEditorState(video.id);
      if (!state) throw new Error('Missing editor state');
      await store.updateJob(job.id, { progress: 20 });
      const outputPath = await renderVideo(state, job.id);
      await store.createRender({
        videoId: video.id,
        jobId: job.id,
        outputPath,
        status: 'done',
        settings: job.payload
      });
      await store.updateVideo(video.id, { renderPath: outputPath, status: 'ready' });
      await store.updateJob(job.id, { status: 'done', progress: 100, result: { outputPath } });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Job ${job.id} failed`, error);
    await store.updateJob(job.id, { status: 'failed', progress: 100, errorText: message });
    await store.updateVideo(job.videoId, { status: 'failed' }).catch(() => undefined);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberFromPayload(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
