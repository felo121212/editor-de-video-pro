import path from 'node:path';

export function assertInside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe path outside storage root: ${child}`);
  }
}

export function toPosixPath(value: string) {
  return value.split(path.sep).join('/');
}

