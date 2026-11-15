import { loadConfig } from './config.mjs';
import { createStore } from './store.mjs';
import { createApp } from './server.mjs';

const config = loadConfig();
const server = createApp({ config, store: createStore(config.dataDir) });

server.listen(config.port, config.host, () => {
  console.log(`Social Poster connect page on http://${config.host}:${config.port} (public URL ${config.publicUrl})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
