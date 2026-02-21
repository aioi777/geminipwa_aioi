// sw.js

const CACHE_NAME = 'gemini-pwa-cache-v2'; 
const urlsToCache = [
  './', // ルートパス (index.html を指すことが多い)
  './index.html',
  './manifest.json',
  './marked.js',
  // アイコンファイルもキャッシュする場合 (manifest.json で指定したもの)
  './icon-192x192.png',
];

// インストール時にキャッシュを作成
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('SW: Opened cache');
        // ネットワーク状況が不安定な場合、addAllが失敗することがある
        // 個別にaddしてエラーを無視するか、必須リソースのみにするなどの考慮も可能
        return cache.addAll(urlsToCache).catch(error => {
          console.error('SW: Failed to cache initial resources during install:', error);
        });
      })
      .then(() => {
        // インストール完了後、すぐにアクティブにする (古いSWを待たない)
        return self.skipWaiting();
      })
  );
});

// フェッチイベントの処理
self.addEventListener('fetch', (event) => {
  // 【修正・追加】
  // Gemini APIへの通信、またはGET以外の通信(POST, PATCH, DELETE等)は即座にバイパス。
  // event.respondWith() を呼ばずに return することで、ブラウザ標準の通信機構(CORS含む)に処理を丸投げし、エラーを防ぐ。
  if (event.request.method !== 'GET' || event.request.url.includes('generativelanguage.googleapis.com')) {
    return;
  }

  const requestUrl = new URL(event.request.url);

  // 【削除】
  // 以前のPOST回避ロジック（if (requestUrl.hostname === ... && event.request.method === 'POST') { event.respondWith(...) }）は不要かつエラー原因のため削除。

  // それ以外のリクエスト (主にGET) はキャッシュ優先戦略 (Cache falling back to network)
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        if (response) return response;

        return fetch(event.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
               const isCachable = urlsToCache.some(url => {
                   if (url === './') return requestUrl.pathname === '/' || requestUrl.pathname === '/index.html';
                   return requestUrl.pathname.endsWith(url.substring(1));
               });

               if (isCachable) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseToCache);
                    });
               }
            }
            return networkResponse;
        }).catch(error => {
          console.error('SW: Fetch failed for:', event.request.url, error);
          if (event.request.headers.get('accept').includes('application/json')) {
            return new Response(JSON.stringify({ error: 'Offline or network error' }), {
              status: 503, headers: { 'Content-Type': 'application/json' }
            });
          }
          return new Response('Network error occurred.', { status: 503, statusText: 'Service Unavailable' });
        });
      })
  );
});

// activateイベントで古いキャッシュを削除 & クライアント制御の要求
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log('SW: Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // 新しいService Workerがアクティブになったら、すぐにクライアントを制御する
      return self.clients.claim();
    })
  );
});

// メッセージリスナー (キャッシュクリア用)
self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'clearCache') {
    console.log('SW: Clearing cache...');
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          return caches.delete(cacheName);
        })
      );
    }).then(() => {
      console.log('SW: Cache cleared.');
      // クライアントに完了を通知 (任意)
      // event.source is not always available, use clients.matchAll
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
          clients.forEach(client => {
              client.postMessage({ status: 'cacheCleared' });
          });
      });

      // Service Worker自体を更新するために登録解除とリロードを促す
      self.registration.unregister().then(() => {
         console.log('SW: Service Worker unregistered. Reload required.');
         // クライアントにリロードを促すメッセージを送る
         self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
             clients.forEach(client => {
                 client.postMessage({ action: 'reloadPage' });
             });
         });
      });
    }).catch(error => {
      console.error('SW: Failed to clear cache:', error);
       self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
          clients.forEach(client => {
              client.postMessage({ status: 'cacheClearFailed', error: error.message });
          });
      });
    });
  }
});