import { env } from './server/env.js';

await import('./server/server.js');

if (env.runWorkerInWeb) {
  await import('./worker/worker.js');
}

