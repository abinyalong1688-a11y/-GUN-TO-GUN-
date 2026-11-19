// serve.mjs —— 本地静态服务器(仅用于自动化测试)
import {createServer} from 'http';
import {readFileSync,existsSync} from 'fs';
import {join,extname} from 'path';

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png'};
const port=process.env.PORT||8137;

createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]);
  if(p==='/')p='/gun-to-gun.html';
  const file=join('dist',p);
  if(!existsSync(file)){res.writeHead(404);res.end('not found');return;}
  res.writeHead(200,{'Content-Type':MIME[extname(file)]||'application/octet-stream'});
  res.end(readFileSync(file));
}).listen(port,()=>{
  console.log(`http://127.0.0.1:${port}/`);
});
