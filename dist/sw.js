// sw.js —— GUN TO GUN 离线缓存(Service Worker,部署到云端时随 dist 一起上传)
// 策略:导航请求网络优先 + 缓存兜底(在线总是拿到最新版);跨域请求(IP 语言探测等)直连不缓存
// 注意:本文件不参与 esbuild 打包,build.mjs 原样拷贝到 dist/,版本号与游戏 VERSION 同步
const CACHE='gtg-v1.3.0';
const ASSETS=['./','./gun-to-gun.html','./manifest.webmanifest'];

self.addEventListener('install',e=>{
  e.waitUntil(
    caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return; // 跨域(IP 探测)直连,失败由页面静默兜底
  if(req.mode==='navigate'){
    // 页面导航:网络优先(保证更新),断网回落缓存
    e.respondWith(
      fetch(req).then(r=>{
        const cp=r.clone();
        caches.open(CACHE).then(c=>c.put('./gun-to-gun.html',cp));
        return r;
      }).catch(()=>caches.match('./gun-to-gun.html'))
    );
    return;
  }
  // 其余同源资源:缓存优先
  e.respondWith(
    caches.match(req).then(hit=>hit||fetch(req))
  );
});
