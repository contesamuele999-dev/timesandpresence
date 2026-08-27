import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.argv[2] || 8000);
const mime = {
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json',
  '.png':'image/png',
  '.svg':'image/svg+xml',
};

createServer(async (request, response)=>{
  try{
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if(file !== root && !file.startsWith(root + sep)) throw new Error('Path non valido');
    if((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    response.writeHead(200, {'Content-Type':mime[extname(file)] || 'application/octet-stream'});
    createReadStream(file).pipe(response);
  }catch(e){
    response.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
    response.end('Non trovato');
  }
}).listen(port, '127.0.0.1', ()=> console.log(`Presencer: http://127.0.0.1:${port}`));

