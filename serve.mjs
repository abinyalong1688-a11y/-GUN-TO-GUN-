// serve.mjs — local static server (automated testing only)
import {createServer} from 'http';
import {readFileSync,existsSync,statSync} from 'fs';
import {join,extname,resolve,sep} from 'path';

const ROOT=resolve('dist');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const port=process.env.PORT||8137;

createServer((req,res)=>{
  let p;
  try{p=decodeURIComponent(req.url.split('?')[0]);}catch{res.writeHead(400);res.end('bad request');return;}
  if(p==='/')p='/gun-to-gun.html';
  const file=join(ROOT,p);
  // Path traversal guard: requests like /..%2Fpackage.json escape dist once join() normalises them
  if(!file.startsWith(ROOT+sep)){res.writeHead(403);res.end('forbidden');return;}
  if(!existsSync(file)||!statSync(file).isFile()){res.writeHead(404);res.end('not found');return;}
  res.writeHead(200,{'Content-Type':MIME[extname(file)]||'application/octet-stream'});
  res.end(readFileSync(file));
}).listen(port,()=>{
  console.log(`http://127.0.0.1:${port}/`);
});
