// Boom Boom service worker.
// Shows a notification when a message arrives while Boom Boom is closed, and
// opens the right chat when you tap it. It doesn't cache anything, so you
// always get the latest version of the app.

const ICON = 'icons/icon-192.png';
const BADGE = 'icons/badge-96.png';

// Apple only allows notifications if every push shows one.
const ua = self.navigator.userAgent || '';
const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(ua) && !/Chrome|CriOS|Chromium|Android|Firefox|FxiOS|Edg/.test(ua);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  // If Boom Boom is open on screen, it already shows the message.
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (!IS_APPLE && windows.some((w) => w.visibilityState === 'visible')) return;

  const conversationId = data.conversation_id || null;
  const tag = conversationId ? `chat-${conversationId}` : 'boom-boom';
  const title = data.title || 'Boom Boom';

  // Several messages from the same chat stack into one notification.
  const existing = await self.registration.getNotifications({ tag });
  const count = existing.reduce((n, x) => Math.max(n, (x.data && x.data.count) || 1), 0) + 1;

  await self.registration.showNotification(count > 1 ? `${title} (${count} new)` : title, {
    body: data.body || 'New message',
    tag,
    renotify: true,
    icon: ICON,
    badge: BADGE,
    timestamp: Date.now(),
    data: { conversation_id: conversationId, count },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const conversationId = event.notification.data && event.notification.data.conversation_id;
  event.waitUntil(openChat(conversationId));
});

async function openChat(conversationId) {
  const scope = self.registration.scope;
  const url = new URL(conversationId ? `./?chat=${encodeURIComponent(conversationId)}` : './', scope).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.find((w) => w.url.startsWith(scope));
  if (existing) {
    try {
      await existing.focus();
      if (conversationId) existing.postMessage({ type: 'open-chat', conversation_id: conversationId });
      return;
    } catch {
      /* couldn't focus it; open a fresh window instead */
    }
  }
  await self.clients.openWindow(url);
}
