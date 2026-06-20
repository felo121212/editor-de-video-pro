import { getStore } from './store.js';

await getStore().migrate();
console.log('Database ready');

