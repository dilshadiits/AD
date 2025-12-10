// Service Worker for Private Chat
// Handles caching, offline support, and push notifications

const CACHE_NAME = 'private-chat-v15';
const STATIC_CACHE = 'private-chat-static-v15';
const DYNAMIC_CACHE = 'private-chat-dynamic-v15';

// Assets to cache immediately on install
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/socket.io/socket.io.js',
  '/manifest.json'
];

// ===== INSTALL EVENT =====
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker...');

  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[SW] Static assets cached');
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error('[SW] Cache failed:', err);
      })
  );
});

// ===== ACTIVATE EVENT =====
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');

  event.waitUntil(
    Promise.all([
      // Clean up old caches
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => {
              return name !== STATIC_CACHE &&
                name !== DYNAMIC_CACHE &&
                name !== CACHE_NAME;
            })
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      }),
      // Take control of all clients
      self.clients.claim()
    ]).then(() => {
      console.log('[SW] Service worker activated');
    })
  );
});

// ===== FETCH EVENT =====
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip socket.io polling requests (let them go through normally)
  if (url.pathname.includes('/socket.io/') && url.search.includes('transport=polling')) {
    return;
  }

  // Skip WebSocket upgrade requests
  if (request.headers.get('Upgrade') === 'websocket') {
    return;
  }

  // Skip API requests (they need fresh data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .catch(() => {
          return new Response(
            JSON.stringify({ error: 'Offline', message: 'Network unavailable' }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        })
    );
    return;
  }

  // For HTML pages - Network first, then cache
  if (request.headers.get('Accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Clone and cache the response
          const responseClone = response.clone();
          caches.open(DYNAMIC_CACHE).then((cache) => {
            cache.put(request, responseClone);
          });
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cachedResponse) => {
            return cachedResponse || caches.match('/');
          });
        })
    );
    return;
  }

  // For static assets - Cache first, then network
  if (isStaticAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          // Return cache but also update in background
          fetchAndCache(request, STATIC_CACHE);
          return cachedResponse;
        }
        return fetchAndCache(request, STATIC_CACHE);
      })
    );
    return;
  }

  // Default - Network first with cache fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only cache successful responses
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(DYNAMIC_CACHE).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(request);
      })
  );
});

// Helper: Check if URL is a static asset
function isStaticAsset(pathname) {
  return /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i.test(pathname);
}

// Helper: Fetch and cache a request
function fetchAndCache(request, cacheName) {
  return fetch(request).then((response) => {
    if (response.ok) {
      const responseClone = response.clone();
      caches.open(cacheName).then((cache) => {
        cache.put(request, responseClone);
      });
    }
    return response;
  });
}

// ===== PUSH NOTIFICATIONS =====
self.addEventListener('push', (event) => {
  console.log('[SW] Push received');

  let data = {
    title: 'Private Chat',
    body: 'New message received',
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: 'chat-notification',
    url: '/'
  };

  // Parse push data if available
  if (event.data) {
    try {
      const pushData = event.data.json();
      data = { ...data, ...pushData };
    } catch (e) {
      // If not JSON, treat as text
      data.body = event.data.text() || data.body;
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/badge-72.png',
    vibrate: [100, 50, 100, 50, 100],
    tag: data.tag || 'chat-notification',
    renotify: true,
    requireInteraction: data.requireInteraction || false,
    silent: false,
    data: {
      url: data.url || '/',
      messageId: data.messageId,
      roomCode: data.roomCode,
      timestamp: Date.now()
    },
    actions: [
      {
        action: 'open',
        title: '💬 Open Chat',
        icon: '/icon-open.png'
      },
      {
        action: 'dismiss',
        title: 'Dismiss',
        icon: '/icon-close.png'
      }
    ]
  };

  // Add image if provided
  if (data.image) {
    options.image = data.image;
  }

  event.waitUntil(
    self.registration.showNotification(data.title, options)
      .catch((err) => {
        console.error('[SW] Notification error:', err);
      })
  );
});

// ===== NOTIFICATION CLICK =====
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.action);

  event.notification.close();

  // Handle dismiss action
  if (event.action === 'dismiss') {
    return;
  }

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then((clientList) => {
      // Check if app is already open
      for (const client of clientList) {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === self.location.origin) {
          // App is open, focus it and send message
          return client.focus().then((focusedClient) => {
            // Notify the client about the notification click
            focusedClient.postMessage({
              type: 'NOTIFICATION_CLICK',
              data: event.notification.data
            });
            return focusedClient;
          });
        }
      }

      // App not open, open new window
      return clients.openWindow(urlToOpen);
    }).catch((err) => {
      console.error('[SW] Notification click error:', err);
    })
  );
});

// ===== NOTIFICATION CLOSE =====
self.addEventListener('notificationclose', (event) => {
  console.log('[SW] Notification closed');

  // Track notification dismissal if needed
  const data = event.notification.data;
  if (data?.messageId) {
    // Could send analytics or update read status
  }
});

// ===== MESSAGE HANDLER (from main thread) =====
self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data);

  const { type, payload } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'CACHE_URLS':
      if (Array.isArray(payload)) {
        event.waitUntil(
          caches.open(DYNAMIC_CACHE).then((cache) => {
            return cache.addAll(payload);
          })
        );
      }
      break;

    case 'CLEAR_CACHE':
      event.waitUntil(
        caches.keys().then((names) => {
          return Promise.all(names.map((name) => caches.delete(name)));
        })
      );
      break;

    case 'GET_CACHE_STATUS':
      event.waitUntil(
        getCacheStatus().then((status) => {
          event.source.postMessage({
            type: 'CACHE_STATUS',
            payload: status
          });
        })
      );
      break;

    case 'SHOW_NOTIFICATION':
      if (payload) {
        event.waitUntil(
          self.registration.showNotification(payload.title || 'Private Chat', {
            body: payload.body,
            icon: payload.icon || '/icon-192.png',
            badge: '/badge-72.png',
            tag: payload.tag || 'local-notification',
            data: payload.data
          })
        );
      }
      break;
  }
});

// Helper: Get cache status
async function getCacheStatus() {
  const cacheNames = await caches.keys();
  const status = {};

  for (const name of cacheNames) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    status[name] = keys.length;
  }

  return status;
}

// ===== SYNC EVENT (Background Sync) =====
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync:', event.tag);

  if (event.tag === 'send-messages') {
    event.waitUntil(sendQueuedMessages());
  }
});

// Helper: Send queued messages (for offline support)
async function sendQueuedMessages() {
  // This would integrate with IndexedDB to send queued messages
  // For now, just notify the client
  const clients = await self.clients.matchAll();
  clients.forEach((client) => {
    client.postMessage({
      type: 'SYNC_COMPLETE',
      payload: { tag: 'send-messages' }
    });
  });
}

// ===== PERIODIC SYNC (if supported) =====
self.addEventListener('periodicsync', (event) => {
  console.log('[SW] Periodic sync:', event.tag);

  if (event.tag === 'check-messages') {
    event.waitUntil(checkForNewMessages());
  }
});

async function checkForNewMessages() {
  // Could check for new messages when app is in background
  console.log('[SW] Checking for new messages...');
}

// ===== ERROR HANDLING =====
self.addEventListener('error', (event) => {
  console.error('[SW] Error:', event.error);
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[SW] Unhandled rejection:', event.reason);
});

console.log('[SW] Service worker loaded');