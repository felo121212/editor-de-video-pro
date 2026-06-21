import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { assertInside, toPosixPath } from '../utils/safePath.js';

export async function ensureStorage() {
  await Promise.all([
    fs.mkdir(env.storageDir, { recursive: true }),
    fs.mkdir(path.join(env.storageDir, 'uploads'), { recursive: true }),
    fs.mkdir(path.join(env.storageDir, 'proxies'), { recursive: true }),
    fs.mkdir(path.join(env.storageDir, 'thumbnails'), { recursive: true }),
    fs.mkdir(path.join(env.storageDir, 'renders'), { recursive: true }),
    fs.mkdir(path.join(env.storageDir, 'assets'), { recursive: true }),
    fs.mkdir(path.join(env.storageDir, 'tmp'), { recursive: true }),
    fs.mkdir(path.join(env.storageDir, 'tmp', 'incoming'), { recursive: true })
  ]);
}

export async function ensureVideoDir(kind: 'uploads' | 'proxies' | 'thumbnails' | 'renders' | 'assets' | 'tmp', videoId: string) {
  const dir = path.join(env.storageDir, kind, videoId);
  assertInside(env.storageDir, dir);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function deleteVideoStorage(videoId: string) {
  await Promise.all(['uploads', 'proxies', 'thumbnails', 'renders', 'assets', 'tmp'].map(async (kind) => {
    const dir = path.join(env.storageDir, kind, videoId);
    assertInside(env.storageDir, dir);
    await fs.rm(dir, { recursive: true, force: true });
  }));
}

export function publicMediaUrl(filePath: string | null | undefined) {
  if (!filePath) return null;
  const absolute = path.resolve(filePath);
  assertInside(env.storageDir, absolute);
  const relative = toPosixPath(path.relative(env.storageDir, absolute));
  const url = `/media/${relative.split('/').map(encodeURIComponent).join('/')}`;
  return env.publicBaseUrl ? `${env.publicBaseUrl}${url}` : url;
}

export function resolveMediaPath(parts: string[]) {
  const absolute = path.resolve(env.storageDir, ...parts);
  assertInside(env.storageDir, absolute);
  return absolute;
}

export function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 140) || 'upload.bin';
}
