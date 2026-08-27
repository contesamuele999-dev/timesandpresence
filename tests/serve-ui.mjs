import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Anteprima isolata: nessuna chiave Supabase, nessuna chiamata al database reale.
const allowed = new Set(['app.js', 'tests/preview.mjs', 'tests/helpers/mock-client.mjs', 'icons/favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png']);
const port = Number(process.argv[2] || 8000);
createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname.slice(1);
    if (!path || path === 'index.html') {
      const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(html.slice(0, html.indexOf('<script src=')) + '<script type="module" src="/tests/preview.mjs"></script></body></html>');
      return;
    }
    if (!allowed.has(path)) { response.writeHead(404).end(); return; }
    const content = await readFile(new URL(`../${path}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': /\.m?js$/.test(path) ? 'text/javascript; charset=utf-8' : path.endsWith('.svg') ? 'image/svg+xml' : 'image/png', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch {
    response.writeHead(500).end('Errore anteprima');
  }
}).listen(port, '127.0.0.1', () => console.log(`Anteprima con soli dati fittizi: http://127.0.0.1:${port}`));
