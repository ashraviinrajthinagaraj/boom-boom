// Checks for sw.js (the service worker), runnable with Node 18+:
//   node tests/sw_test.mjs
// Runs the service worker in a fake browser environment and simulates
// notifications arriving and being tapped.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const results = [];
const check = (cond, label) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${label}`);

// A stand-in for the browser's Cache Storage, holding what the app saved.
function fakeCaches(files = {}) {
  return {
    async open(name) {
      return {
        async match(url) {
          const body = files[`${name} ${url}`];
          return body == null ? undefined : { json: async () => JSON.parse(body) };
        },
      };
    },
  };
}

function load({ userAgent = 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile', windows = [], caches = fakeCaches() } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const registration = {
    scope: 'https://ashraviinrajthinagaraj.github.io/boom-boom/',
    async showNotification(title, options) { shown.push({ title, ...options }); },
    async getNotifications({ tag }) { return shown.filter((n) => n.tag === tag).map((n) => ({ data: n.data })); },
  };
  const self = {
    navigator: { userAgent },
    registration,
    clients: {
      async matchAll() { return windows; },
      async openWindow(url) { opened.push(url); },
      claim: async () => {},
    },
    skipWaiting: () => {},
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  vm.runInNewContext(source, { self, URL, console, Date, encodeURIComponent, String, caches });
  async function fire(type, event) {
    let pending;
    handlers[type]({ ...event, waitUntil: (p) => { pending = p; } });
    await pending;
  }
  return { fire, shown, opened };
}
const pushEvent = (obj) => ({ data: { json: () => obj, text: () => JSON.stringify(obj) } });

// Closed app: notification appears with sender and preview
{
  const sw = load();
  await sw.fire('push', pushEvent({ title: 'Bala', body: 'Library at 4?', conversation_id: 'c1' }));
  check(sw.shown.length === 1 && sw.shown[0].title === 'Bala' && sw.shown[0].body === 'Library at 4?', 'App closed: notification shows sender and message');
  check(sw.shown[0].tag === 'chat-c1' && sw.shown[0].data.conversation_id === 'c1' && sw.shown[0].icon && sw.shown[0].badge, 'Notification knows which chat it belongs to and has icons');
  await sw.fire('push', pushEvent({ title: 'Bala', body: 'Bring the notes', conversation_id: 'c1' }));
  check(sw.shown[1].title === 'Bala (2 new)' && sw.shown[1].body === 'Bring the notes', 'A second message from the same chat stacks into "(2 new)"');
}

// App open on screen (Android/desktop): no duplicate notification
{
  const sw = load({ windows: [{ visibilityState: 'visible', url: 'https://ashraviinrajthinagaraj.github.io/boom-boom/' }] });
  await sw.fire('push', pushEvent({ title: 'Chen', body: 'Hi', conversation_id: 'c2' }));
  check(sw.shown.length === 0, 'App open on screen: no extra notification');
}

// iPhone: must always show one
{
  const sw = load({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    windows: [{ visibilityState: 'visible', url: 'https://ashraviinrajthinagaraj.github.io/boom-boom/' }],
  });
  await sw.fire('push', pushEvent({ title: 'Chen', body: 'Hi', conversation_id: 'c2' }));
  check(sw.shown.length === 1, 'iPhone: always shows the notification (Apple requires it)');
}

// Unreadable payload still shows something
{
  const sw = load();
  await sw.fire('push', { data: { json: () => { throw new Error('bad'); }, text: () => 'plain text' } });
  check(sw.shown.length === 1 && sw.shown[0].title === 'Boom Boom' && sw.shown[0].body === 'plain text', 'Odd payloads still show a sensible notification');
}

// Nicknames: notifications use the name you gave your friend
{
  const file = 'boom-local https://ashraviinrajthinagaraj.github.io/boom-boom/__nicknames.json';
  const sw = load({ caches: fakeCaches({ [file]: JSON.stringify({ c1: 'Bala Bro' }) }) });
  await sw.fire('push', pushEvent({ title: 'Bala Krishnan', body: 'Hi', conversation_id: 'c1' }));
  await sw.fire('push', pushEvent({ title: 'Chen', body: 'Yo', conversation_id: 'c2' }));
  check(sw.shown[0].title === 'Bala Bro' && sw.shown[1].title === 'Chen', 'Notifications use your nickname, and real names for everyone else');
  const broken = load({ caches: { open: async () => { throw new Error('storage blocked'); } } });
  await broken.fire('push', pushEvent({ title: 'Bala Krishnan', body: 'Hi', conversation_id: 'c1' }));
  check(broken.shown[0]?.title === 'Bala Krishnan', 'If the nickname list can\'t be read, the real name is used');
}

// Text styling markers don't show up in notifications
{
  const sw = load();
  await sw.fire('push', pushEvent({ title: 'Bala', body: 'see you *tonight* at _8_ ~maybe~ https://x.com/_a_ and snake_case_name', conversation_id: 'c9' }));
  check(sw.shown[0].body === 'see you tonight at 8 maybe https://x.com/_a_ and snake_case_name', `Styling symbols are removed from the preview, links untouched (${sw.shown[0].body})`);
}

// Tapping: open the right chat
{
  const sw = load();
  const n = { data: { conversation_id: 'c1' }, closed: false, close() { this.closed = true; } };
  await sw.fire('notificationclick', { notification: n });
  check(n.closed && sw.opened[0] === 'https://ashraviinrajthinagaraj.github.io/boom-boom/?chat=c1', 'Tapping with the app closed opens that chat');
}
{
  const posted = [];
  const win = { url: 'https://ashraviinrajthinagaraj.github.io/boom-boom/', visibilityState: 'hidden', focus: async () => {}, postMessage: (m) => posted.push(m) };
  const sw = load({ windows: [win] });
  await sw.fire('notificationclick', { notification: { data: { conversation_id: 'c3' }, close() {} } });
  check(sw.opened.length === 0 && posted[0]?.type === 'open-chat' && posted[0].conversation_id === 'c3', 'Tapping with the app in the background switches to that chat');
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
