// sw.js — GUN TO GUN offline cache (service worker, uploaded alongside dist when deployed)
// Strategy: navigations are network-first with cache fallback (online always gets the latest); cross-origin requests (IP language probe etc.) bypass the cache
// Note: this file is not bundled by esbuild; build.mjs copies it into dist/ and syncs the version with the game VERSION
const CACHE='gtg-v1.8.1'; // build.mjs injects the package.json version at build time so it cannot drift from the game VERSION
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
  if(url.origin!==self.location.origin)return; // cross-origin (IP probe) goes straight to network; the page handles failure silently
  if(req.mode==='navigate'){
    // Navigations: network-first (picks up updates), fall back to cache when offline
    e.respondWith(
      fetch(req).then(r=>{
        const cp=r.clone();
        caches.open(CACHE).then(c=>c.put('./gun-to-gun.html',cp));
        return r;
      }).catch(()=>caches.match('./gun-to-gun.html'))
    );
    return;
  }
  // Other same-origin assets: cache-first
  e.respondWith(
    caches.match(req).then(hit=>hit||fetch(req))
  );
});
