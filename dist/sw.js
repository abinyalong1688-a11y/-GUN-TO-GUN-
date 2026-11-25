// sw.js — GUN TO GUN offline cache (service worker, uploaded alongside dist when deployed)
// Strategy: navigations are stale-while-revalidate (instant from cache, refreshed in the
// background); cross-origin requests (IP language probe etc.) bypass the cache.
// Note: this file is not bundled by esbuild; build.mjs copies it into dist/ and syncs the
// version with the game VERSION.
const CACHE='gtg-v1.11.3'; // build.mjs injects the package.json version at build time so it cannot drift from the game VERSION
const PAGE='./gun-to-gun.html';
const PAGE_URL=new URL(PAGE,self.location.href);
const APP_INDEX=new URL('./',self.location.href).pathname;
/* This origin also hosts a separately scoped build under /5v5/. A root-scope navigation handler
   would otherwise answer /5v5/ with this cached page (and overwrite its cache with that HTML), so
   only the page(s) of this app are handled. Works for a /dist/ deployment too. */
const isAppNavigation=pathname=>
  pathname===PAGE_URL.pathname||pathname===APP_INDEX||pathname===APP_INDEX+'index.html';
// IMPORTANT: './' must NOT be pre-cached. GitHub Pages has no /dist/index.html, so /dist/
// returns 404 and caches.addAll() rejects the WHOLE install — the SW would never activate
// and every visit would re-download the large HTML. The page fetched here is normally served
// straight from the browser HTTP cache (GitHub Pages sends max-age=600), so immediately after
// the first visit this costs practically zero extra transfer.
const ASSETS=[PAGE,'./manifest.webmanifest','./icon-192.png','./icon-512.png'];

self.addEventListener('install',e=>{
  e.waitUntil(
    caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      // Only retire this app's old caches; a /5v5/ build on the same origin owns its own.
      .then(ks=>Promise.all(ks.filter(k=>k.startsWith('gtg-v')&&k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return; // cross-origin (IP probe) goes straight to network; the page handles failure silently

  if(req.mode==='navigate'){
    if(!isAppNavigation(url.pathname))return; // /5v5/ (or any other app) goes to its own scope/network
    // Start the network refresh immediately, but do not make the user wait for GitHub Pages.
    // The cached copy is returned instantly; the fresh response replaces it for the next visit.
    const network=fetch(req).then(r=>{
      if(!r||!r.ok)return r;
      return caches.open(CACHE)
        .then(c=>c.put(PAGE,r.clone()))
        .catch(()=>{})
        .then(()=>r);
    }).catch(()=>null);
    e.waitUntil(network);
    e.respondWith(
      caches.match(PAGE).then(hit=>hit||network.then(r=>r||new Response(
        'Offline — open the page once while online to cache it.',
        {status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}}
      )))
    );
    return;
  }
  // Other same-origin assets: cache-first
  e.respondWith(
    caches.match(req).then(hit=>hit||fetch(req))
  );
});
