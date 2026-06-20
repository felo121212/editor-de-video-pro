import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import mysql from 'mysql2/promise';
import { env } from '../env.js';
import { nowIso } from '../utils/time.js';
import {
  defaultSubtitleStyle,
  EditorState,
  ImageAsset,
  JobStatus,
  JobType,
  RenderRecord,
  SilenceSegment,
  SubtitleCue,
  TimelineEvent,
  TranscriptSegment,
  VideoJob,
  VideoProject
} from '../../shared/types.js';

export interface Store {
  migrate(): Promise<void>;
  listVideos(): Promise<VideoProject[]>;
  getVideo(id: string): Promise<VideoProject | null>;
  createVideo(input: Pick<VideoProject, 'title' | 'originalPath'>): Promise<VideoProject>;
  updateVideo(id: string, patch: Partial<VideoProject>): Promise<VideoProject>;
  deleteVideo(id: string): Promise<void>;
  createJob(videoId: string, type: JobType, payload?: Record<string, unknown>): Promise<VideoJob>;
  getJob(id: string): Promise<VideoJob | null>;
  listJobs(videoId: string): Promise<VideoJob[]>;
  claimNextJob(workerId: string): Promise<VideoJob | null>;
  requeueStaleJobs(staleMs: number, maxAttempts: number): Promise<number>;
  updateJob(id: string, patch: Partial<VideoJob>): Promise<VideoJob>;
  replaceSilences(videoId: string, rows: SilenceSegment[]): Promise<SilenceSegment[]>;
  getSilences(videoId: string): Promise<SilenceSegment[]>;
  replaceTranscript(videoId: string, rows: TranscriptSegment[]): Promise<TranscriptSegment[]>;
  getTranscript(videoId: string): Promise<TranscriptSegment[]>;
  replaceSubtitles(videoId: string, rows: SubtitleCue[]): Promise<SubtitleCue[]>;
  getSubtitles(videoId: string): Promise<SubtitleCue[]>;
  createAsset(input: Omit<ImageAsset, 'id'>): Promise<ImageAsset>;
  updateAsset(id: string, patch: Partial<ImageAsset>): Promise<ImageAsset>;
  getAssets(videoId: string): Promise<ImageAsset[]>;
  deleteAsset(id: string): Promise<void>;
  replaceTimeline(videoId: string, rows: TimelineEvent[]): Promise<TimelineEvent[]>;
  getTimeline(videoId: string): Promise<TimelineEvent[]>;
  createRender(input: Omit<RenderRecord, 'id' | 'createdAt'>): Promise<RenderRecord>;
  listRenders(videoId: string): Promise<RenderRecord[]>;
  getEditorState(videoId: string): Promise<EditorState | null>;
}

interface JsonShape {
  videos: VideoProject[];
  jobs: VideoJob[];
  silences: SilenceSegment[];
  transcript: TranscriptSegment[];
  subtitles: SubtitleCue[];
  assets: ImageAsset[];
  timeline: TimelineEvent[];
  renders: RenderRecord[];
}

const emptyDb = (): JsonShape => ({
  videos: [],
  jobs: [],
  silences: [],
  transcript: [],
  subtitles: [],
  assets: [],
  timeline: [],
  renders: []
});

function id() {
  return nanoid(12);
}

function sortByTime<T extends { createdAt?: string; startMs?: number }>(items: T[]) {
  return [...items].sort((a, b) => {
    if (a.startMs !== undefined && b.startMs !== undefined) return a.startMs - b.startMs;
    return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  });
}

class JsonStore implements Store {
  private file = path.resolve(process.cwd(), '.data/dev-db.json');
  private mutex = Promise.resolve();

  async migrate() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      await fs.access(this.file);
    } catch {
      await fs.writeFile(this.file, JSON.stringify(emptyDb(), null, 2));
    }
  }

  private async read(): Promise<JsonShape> {
    await this.migrate();
    return JSON.parse(await fs.readFile(this.file, 'utf8')) as JsonShape;
  }

  private async write(db: JsonShape) {
    await fs.writeFile(this.file, JSON.stringify(db, null, 2));
  }

  private async tx<T>(fn: (db: JsonShape) => T | Promise<T>) {
    const run = async () => {
      const db = await this.read();
      const result = await fn(db);
      await this.write(db);
      return result;
    };
    const next = this.mutex.then(run, run);
    this.mutex = next.then(() => undefined, () => undefined);
    return next;
  }

  async listVideos() {
    const db = await this.read();
    return sortByTime(db.videos);
  }

  async getVideo(videoId: string) {
    const db = await this.read();
    return db.videos.find((video) => video.id === videoId) ?? null;
  }

  async createVideo(input: Pick<VideoProject, 'title' | 'originalPath'>) {
    return this.tx((db) => {
      const now = nowIso();
      const video: VideoProject = {
        id: id(),
        title: input.title,
        originalPath: input.originalPath,
        proxyPath: null,
        renderPath: null,
        durationMs: 0,
        width: 0,
        height: 0,
        fps: 30,
        status: 'uploaded',
        createdAt: now,
        updatedAt: now
      };
      db.videos.push(video);
      return video;
    });
  }

  async updateVideo(videoId: string, patch: Partial<VideoProject>) {
    return this.tx((db) => {
      const video = db.videos.find((item) => item.id === videoId);
      if (!video) throw new Error('Video not found');
      Object.assign(video, patch, { updatedAt: nowIso() });
      return video;
    });
  }

  async deleteVideo(videoId: string) {
    await this.tx((db) => {
      db.videos = db.videos.filter((video) => video.id !== videoId);
      db.jobs = db.jobs.filter((job) => job.videoId !== videoId);
      db.silences = db.silences.filter((row) => row.videoId !== videoId);
      db.transcript = db.transcript.filter((row) => row.videoId !== videoId);
      db.subtitles = db.subtitles.filter((row) => row.videoId !== videoId);
      db.assets = db.assets.filter((row) => row.videoId !== videoId);
      db.timeline = db.timeline.filter((row) => row.videoId !== videoId);
      db.renders = db.renders.filter((row) => row.videoId !== videoId);
    });
  }

  async createJob(videoId: string, type: JobType, payload: Record<string, unknown> = {}) {
    return this.tx((db) => {
      const now = nowIso();
      const job: VideoJob = {
        id: id(),
        videoId,
        type,
        status: 'queued',
        progress: 0,
        payload,
        result: {},
        errorText: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now
      };
      db.jobs.push(job);
      return job;
    });
  }

  async getJob(jobId: string) {
    const db = await this.read();
    return db.jobs.find((job) => job.id === jobId) ?? null;
  }

  async listJobs(videoId: string) {
    const db = await this.read();
    return sortByTime(db.jobs.filter((job) => job.videoId === videoId));
  }

  async claimNextJob(workerId: string) {
    return this.tx((db) => {
      const job = db.jobs
        .filter((item) => item.status === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return null;
      job.status = 'running';
      job.progress = Math.max(job.progress, 1);
      job.attempts += 1;
      job.payload = { ...job.payload, lockedBy: workerId, lockedAt: nowIso() };
      job.updatedAt = nowIso();
      return job;
    });
  }

  async requeueStaleJobs(staleMs: number, maxAttempts: number) {
    return this.tx((db) => {
      const cutoff = Date.now() - staleMs;
      let count = 0;
      for (const job of db.jobs) {
        if (job.status !== 'running') continue;
        if (job.attempts >= maxAttempts) {
          job.status = 'failed';
          job.errorText = 'Job exceeded retry attempts after worker restart.';
          job.updatedAt = nowIso();
          count += 1;
          continue;
        }
        if (Date.parse(job.updatedAt) < cutoff) {
          job.status = 'queued';
          job.progress = 0;
          job.errorText = null;
          job.updatedAt = nowIso();
          count += 1;
        }
      }
      return count;
    });
  }

  async updateJob(jobId: string, patch: Partial<VideoJob>) {
    return this.tx((db) => {
      const job = db.jobs.find((item) => item.id === jobId);
      if (!job) throw new Error('Job not found');
      Object.assign(job, patch, { updatedAt: nowIso() });
      return job;
    });
  }

  async replaceSilences(videoId: string, rows: SilenceSegment[]) {
    return this.tx((db) => {
      db.silences = db.silences.filter((row) => row.videoId !== videoId).concat(rows);
      return sortByTime(rows);
    });
  }

  async getSilences(videoId: string) {
    const db = await this.read();
    return sortByTime(db.silences.filter((row) => row.videoId === videoId));
  }

  async replaceTranscript(videoId: string, rows: TranscriptSegment[]) {
    return this.tx((db) => {
      db.transcript = db.transcript.filter((row) => row.videoId !== videoId).concat(rows);
      return sortByTime(rows);
    });
  }

  async getTranscript(videoId: string) {
    const db = await this.read();
    return sortByTime(db.transcript.filter((row) => row.videoId === videoId));
  }

  async replaceSubtitles(videoId: string, rows: SubtitleCue[]) {
    return this.tx((db) => {
      db.subtitles = db.subtitles.filter((row) => row.videoId !== videoId).concat(rows);
      return sortByTime(rows);
    });
  }

  async getSubtitles(videoId: string) {
    const db = await this.read();
    return sortByTime(db.subtitles.filter((row) => row.videoId === videoId));
  }

  async createAsset(input: Omit<ImageAsset, 'id'>) {
    return this.tx((db) => {
      const asset: ImageAsset = { ...input, id: id() };
      db.assets.push(asset);
      return asset;
    });
  }

  async updateAsset(assetId: string, patch: Partial<ImageAsset>) {
    return this.tx((db) => {
      const asset = db.assets.find((item) => item.id === assetId);
      if (!asset) throw new Error('Asset not found');
      Object.assign(asset, patch);
      return asset;
    });
  }

  async getAssets(videoId: string) {
    const db = await this.read();
    return db.assets.filter((row) => row.videoId === videoId);
  }

  async deleteAsset(assetId: string) {
    await this.tx((db) => {
      db.assets = db.assets.filter((row) => row.id !== assetId);
    });
  }

  async replaceTimeline(videoId: string, rows: TimelineEvent[]) {
    return this.tx((db) => {
      db.timeline = db.timeline.filter((row) => row.videoId !== videoId).concat(rows);
      return sortByTime(rows);
    });
  }

  async getTimeline(videoId: string) {
    const db = await this.read();
    return sortByTime(db.timeline.filter((row) => row.videoId === videoId));
  }

  async createRender(input: Omit<RenderRecord, 'id' | 'createdAt'>) {
    return this.tx((db) => {
      const render: RenderRecord = { ...input, id: id(), createdAt: nowIso() };
      db.renders.unshift(render);
      return render;
    });
  }

  async listRenders(videoId: string) {
    const db = await this.read();
    return db.renders.filter((row) => row.videoId === videoId);
  }

  async getEditorState(videoId: string) {
    const video = await this.getVideo(videoId);
    if (!video) return null;
    return {
      video,
      jobs: await this.listJobs(videoId),
      silences: await this.getSilences(videoId),
      transcript: await this.getTranscript(videoId),
      subtitles: await this.getSubtitles(videoId),
      assets: await this.getAssets(videoId),
      timeline: await this.getTimeline(videoId),
      renders: await this.listRenders(videoId)
    };
  }
}

function toVideo(row: Record<string, any>): VideoProject {
  return {
    id: row.id,
    title: row.title,
    originalPath: row.original_path,
    proxyPath: row.proxy_path,
    renderPath: row.render_path,
    durationMs: Number(row.duration_ms),
    width: Number(row.width),
    height: Number(row.height),
    fps: Number(row.fps),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function toJob(row: Record<string, any>): VideoJob {
  return {
    id: row.id,
    videoId: row.video_id,
    type: row.type,
    status: row.status,
    progress: Number(row.progress),
    payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json ?? {},
    result: typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json ?? {},
    errorText: row.error_text,
    attempts: Number(row.attempts),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

class MySqlStore implements Store {
  private pool = mysql.createPool(env.databaseUrl);

  async migrate() {
    const sql = await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
      await this.pool.query(statement);
    }
  }

  async listVideos() {
    const [rows] = await this.pool.query('SELECT * FROM videos ORDER BY created_at DESC');
    return (rows as Record<string, any>[]).map(toVideo);
  }

  async getVideo(videoId: string) {
    const [rows] = await this.pool.query('SELECT * FROM videos WHERE id = ?', [videoId]);
    const row = (rows as Record<string, any>[])[0];
    return row ? toVideo(row) : null;
  }

  async createVideo(input: Pick<VideoProject, 'title' | 'originalPath'>) {
    const now = new Date();
    const videoId = id();
    await this.pool.query(
      'INSERT INTO videos (id,title,original_path,duration_ms,width,height,fps,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [videoId, input.title, input.originalPath, 0, 0, 0, 30, 'uploaded', now, now]
    );
    const video = await this.getVideo(videoId);
    if (!video) throw new Error('Video create failed');
    return video;
  }

  async updateVideo(videoId: string, patch: Partial<VideoProject>) {
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.originalPath !== undefined) fields.original_path = patch.originalPath;
    if (patch.proxyPath !== undefined) fields.proxy_path = patch.proxyPath;
    if (patch.renderPath !== undefined) fields.render_path = patch.renderPath;
    if (patch.durationMs !== undefined) fields.duration_ms = patch.durationMs;
    if (patch.width !== undefined) fields.width = patch.width;
    if (patch.height !== undefined) fields.height = patch.height;
    if (patch.fps !== undefined) fields.fps = patch.fps;
    if (patch.status !== undefined) fields.status = patch.status;
    fields.updated_at = new Date();
    const columns = Object.keys(fields);
    await this.pool.query(
      `UPDATE videos SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((column) => fields[column]), videoId]
    );
    const video = await this.getVideo(videoId);
    if (!video) throw new Error('Video not found');
    return video;
  }

  async deleteVideo(videoId: string) {
    await this.pool.query('DELETE FROM videos WHERE id = ?', [videoId]);
  }

  async createJob(videoId: string, type: JobType, payload: Record<string, unknown> = {}) {
    const jobId = id();
    const now = new Date();
    await this.pool.query(
      'INSERT INTO video_jobs (id,video_id,type,status,progress,payload_json,result_json,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [jobId, videoId, type, 'queued', 0, JSON.stringify(payload), JSON.stringify({}), 0, now, now]
    );
    const job = await this.getJob(jobId);
    if (!job) throw new Error('Job create failed');
    return job;
  }

  async getJob(jobId: string) {
    const [rows] = await this.pool.query('SELECT * FROM video_jobs WHERE id = ?', [jobId]);
    const row = (rows as Record<string, any>[])[0];
    return row ? toJob(row) : null;
  }

  async listJobs(videoId: string) {
    const [rows] = await this.pool.query('SELECT * FROM video_jobs WHERE video_id = ? ORDER BY created_at DESC', [videoId]);
    return (rows as Record<string, any>[]).map(toJob);
  }

  async claimNextJob(workerId: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        "SELECT * FROM video_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
      );
      const row = (rows as Record<string, any>[])[0];
      if (!row) {
        await connection.commit();
        return null;
      }
      await connection.query(
        "UPDATE video_jobs SET status = 'running', progress = GREATEST(progress, 1), locked_at = ?, locked_by = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?",
        [new Date(), workerId, new Date(), row.id]
      );
      await connection.commit();
      return this.getJob(row.id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async requeueStaleJobs(staleMs: number, maxAttempts: number) {
    const cutoff = new Date(Date.now() - staleMs);
    const [failed] = await this.pool.query(
      "UPDATE video_jobs SET status = 'failed', error_text = 'Job exceeded retry attempts after worker restart.', updated_at = ? WHERE status = 'running' AND attempts >= ? AND updated_at < ?",
      [new Date(), maxAttempts, cutoff]
    );
    const [requeued] = await this.pool.query(
      "UPDATE video_jobs SET status = 'queued', progress = 0, error_text = NULL, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE status = 'running' AND attempts < ? AND updated_at < ?",
      [new Date(), maxAttempts, cutoff]
    );
    return Number((failed as mysql.ResultSetHeader).affectedRows ?? 0) + Number((requeued as mysql.ResultSetHeader).affectedRows ?? 0);
  }

  async updateJob(jobId: string, patch: Partial<VideoJob>) {
    const fields: Record<string, unknown> = {};
    if (patch.status !== undefined) fields.status = patch.status;
    if (patch.progress !== undefined) fields.progress = patch.progress;
    if (patch.payload !== undefined) fields.payload_json = JSON.stringify(patch.payload);
    if (patch.result !== undefined) fields.result_json = JSON.stringify(patch.result);
    if (patch.errorText !== undefined) fields.error_text = patch.errorText;
    if (patch.attempts !== undefined) fields.attempts = patch.attempts;
    fields.updated_at = new Date();
    const columns = Object.keys(fields);
    await this.pool.query(
      `UPDATE video_jobs SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((column) => fields[column]), jobId]
    );
    const job = await this.getJob(jobId);
    if (!job) throw new Error('Job not found');
    return job;
  }

  async replaceSilences(videoId: string, rows: SilenceSegment[]) {
    await this.pool.query('DELETE FROM silence_segments WHERE video_id = ?', [videoId]);
    for (const row of rows) {
      await this.pool.query(
        'INSERT INTO silence_segments (id,video_id,start_ms,end_ms,duration_ms,action) VALUES (?,?,?,?,?,?)',
        [row.id, videoId, row.startMs, row.endMs, row.durationMs, row.action]
      );
    }
    return this.getSilences(videoId);
  }

  async getSilences(videoId: string) {
    const [rows] = await this.pool.query('SELECT * FROM silence_segments WHERE video_id = ? ORDER BY start_ms ASC', [videoId]);
    return (rows as Record<string, any>[]).map((row) => ({
      id: row.id,
      videoId: row.video_id,
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      durationMs: Number(row.duration_ms),
      action: row.action
    }));
  }

  async replaceTranscript(videoId: string, rows: TranscriptSegment[]) {
    await this.pool.query('DELETE FROM transcript_segments WHERE video_id = ?', [videoId]);
    for (const row of rows) {
      await this.pool.query(
        'INSERT INTO transcript_segments (id,video_id,start_ms,end_ms,text,source) VALUES (?,?,?,?,?,?)',
        [row.id, videoId, row.startMs, row.endMs, row.text, row.source]
      );
    }
    return this.getTranscript(videoId);
  }

  async getTranscript(videoId: string) {
    const [rows] = await this.pool.query('SELECT * FROM transcript_segments WHERE video_id = ? ORDER BY start_ms ASC', [videoId]);
    return (rows as Record<string, any>[]).map((row) => ({
      id: row.id,
      videoId: row.video_id,
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      text: row.text,
      source: row.source
    }));
  }

  async replaceSubtitles(videoId: string, rows: SubtitleCue[]) {
    await this.pool.query('DELETE FROM subtitle_cues WHERE video_id = ?', [videoId]);
    for (const row of rows) {
      await this.pool.query(
        'INSERT INTO subtitle_cues (id,video_id,start_ms,end_ms,text,style_json) VALUES (?,?,?,?,?,?)',
        [row.id, videoId, row.startMs, row.endMs, row.text, JSON.stringify(row.style ?? defaultSubtitleStyle)]
      );
    }
    return this.getSubtitles(videoId);
  }

  async getSubtitles(videoId: string) {
    const [rows] = await this.pool.query('SELECT * FROM subtitle_cues WHERE video_id = ? ORDER BY start_ms ASC', [videoId]);
    return (rows as Record<string, any>[]).map((row) => ({
      id: row.id,
      videoId: row.video_id,
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      text: row.text,
      style: typeof row.style_json === 'string' ? JSON.parse(row.style_json) : row.style_json
    }));
  }

  async createAsset(input: Omit<ImageAsset, 'id'>) {
    const asset: ImageAsset = { ...input, id: id() };
    await this.pool.query(
      'INSERT INTO image_assets (id,video_id,label,file_path,trigger_words_json,position_json,timing_mode) VALUES (?,?,?,?,?,?,?)',
      [asset.id, asset.videoId, asset.label, asset.filePath, JSON.stringify(asset.triggerWords), JSON.stringify(asset.position), asset.timingMode]
    );
    return asset;
  }

  async updateAsset(assetId: string, patch: Partial<ImageAsset>) {
    const currentRows = await this.pool.query('SELECT * FROM image_assets WHERE id = ?', [assetId]);
    const current = (currentRows[0] as Record<string, any>[])[0];
    if (!current) throw new Error('Asset not found');
    const next: ImageAsset = {
      id: current.id,
      videoId: current.video_id,
      label: patch.label ?? current.label,
      filePath: patch.filePath ?? current.file_path,
      triggerWords: patch.triggerWords ?? JSON.parse(current.trigger_words_json),
      position: patch.position ?? JSON.parse(current.position_json),
      timingMode: patch.timingMode ?? current.timing_mode
    };
    await this.pool.query(
      'UPDATE image_assets SET label=?, file_path=?, trigger_words_json=?, position_json=?, timing_mode=? WHERE id=?',
      [next.label, next.filePath, JSON.stringify(next.triggerWords), JSON.stringify(next.position), next.timingMode, assetId]
    );
    return next;
  }

  async getAssets(videoId: string) {
    const [rows] = await this.pool.query('SELECT * FROM image_assets WHERE video_id = ?', [videoId]);
    return (rows as Record<string, any>[]).map((row) => ({
      id: row.id,
      videoId: row.video_id,
      label: row.label,
      filePath: row.file_path,
      triggerWords: typeof row.trigger_words_json === 'string' ? JSON.parse(row.trigger_words_json) : row.trigger_words_json,
      position: typeof row.position_json === 'string' ? JSON.parse(row.position_json) : row.position_json,
      timingMode: row.timing_mode
    }));
  }

  async deleteAsset(assetId: string) {
    await this.pool.query('DELETE FROM image_assets WHERE id = ?', [assetId]);
  }

  async replaceTimeline(videoId: string, rows: TimelineEvent[]) {
    await this.pool.query('DELETE FROM timeline_events WHERE video_id = ?', [videoId]);
    for (const row of rows) {
      await this.pool.query(
        'INSERT INTO timeline_events (id,video_id,type,start_ms,end_ms,enabled,payload_json) VALUES (?,?,?,?,?,?,?)',
        [row.id, videoId, row.type, row.startMs, row.endMs, row.enabled, JSON.stringify(row.payload)]
      );
    }
    return this.getTimeline(videoId);
  }

  async getTimeline(videoId: string) {
    const [rows] = await this.pool.query('SELECT * FROM timeline_events WHERE video_id = ? ORDER BY start_ms ASC', [videoId]);
    return (rows as Record<string, any>[]).map((row) => ({
      id: row.id,
      videoId: row.video_id,
      type: row.type,
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      enabled: Boolean(row.enabled),
      payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json
    }));
  }

  async createRender(input: Omit<RenderRecord, 'id' | 'createdAt'>) {
    const render: RenderRecord = { ...input, id: id(), createdAt: nowIso() };
    await this.pool.query(
      'INSERT INTO renders (id,video_id,job_id,output_path,status,settings_json,created_at) VALUES (?,?,?,?,?,?,?)',
      [render.id, render.videoId, render.jobId, render.outputPath, render.status, JSON.stringify(render.settings), new Date(render.createdAt)]
    );
    return render;
  }

  async listRenders(videoId: string) {
    const [rows] = await this.pool.query('SELECT * FROM renders WHERE video_id = ? ORDER BY created_at DESC', [videoId]);
    return (rows as Record<string, any>[]).map((row) => ({
      id: row.id,
      videoId: row.video_id,
      jobId: row.job_id,
      outputPath: row.output_path,
      status: row.status,
      settings: typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) : row.settings_json,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  async getEditorState(videoId: string) {
    const video = await this.getVideo(videoId);
    if (!video) return null;
    return {
      video,
      jobs: await this.listJobs(videoId),
      silences: await this.getSilences(videoId),
      transcript: await this.getTranscript(videoId),
      subtitles: await this.getSubtitles(videoId),
      assets: await this.getAssets(videoId),
      timeline: await this.getTimeline(videoId),
      renders: await this.listRenders(videoId)
    };
  }
}

let store: Store | null = null;

export function getStore(): Store {
  if (!store) {
    store = env.databaseUrl ? new MySqlStore() : new JsonStore();
  }
  return store;
}

export function createId() {
  return id();
}
