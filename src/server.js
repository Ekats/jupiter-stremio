import http from 'node:http';
import pkg from 'stremio-addon-sdk';
import { buildAddon } from './addon.js';
import { landingPage } from './landing.js';

const { getRouter } = pkg;

const port = Number(process.env.PORT) || 7000;
// Defaults to all interfaces so phones and TVs on the same network can reach
// it. Set HOST=127.0.0.1 to keep it to this machine only.
const host = process.env.HOST || '0.0.0.0';

const addonInterface = await buildAddon();
const router = getRouter(addonInterface);

const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/' || path === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Trust a proxy's forwarded scheme so an HTTPS deployment offers the
    // one-click link and a plain-HTTP one does not.
    const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    res.end(landingPage(addonInterface.manifest,
      req.headers.host || `127.0.0.1:${port}`, secure));
    return;
  }
  router(req, res, () => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ err: 'not found' }));
  });
});

server.listen(port, host, () => {
  console.log(`ERR Jupiter addon listening on ${host}:${port}`);
  console.log(`  open http://127.0.0.1:${port}/ for install instructions`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
