// Boom Boom — private messaging for a group of friends.
// Front end only: Supabase stores the messages, checks who's allowed to read
// them, and pushes new ones to everyone live. A small service worker (sw.js)
// shows notifications when the app is closed.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import * as config from './config.js';
import { preparePhoto } from './photo.js';

const { SUPABASE_URL, SUPABASE_KEY } = config;
const VAPID_KEY = (config.VAPID_PUBLIC_KEY || '').trim();

window.__boomStarted = true;

// ---------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;
const GROUP_GAP_MS = 5 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const isTouch = window.matchMedia('(pointer: coarse)').matches;
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const MSG_COLUMNS_V1 = 'id, conversation_id, sender_id, body, created_at';
const MSG_COLUMNS_V2 = `${MSG_COLUMNS_V1}, reply_to, photo_path, photo_thumb_path, photo_width, photo_height, deleted_at`;
const AVATAR_COLOURS = ['#3346B8', '#C8174B','#0F7B6C', '#9A4A00', '#6A3FB5', '#2F6E1F', '#B0306E', '#1F6F9F'];

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid); // strings become text, never HTML
  }
  return el;
}

function hashString(text) {
  let hash = 2166136261; // FNV-1a: spreads similar ids across colours
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function initials(name) {
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

function avatarEl(person, size = '') {
  const name = person?.display_name || '?';
  const colour = AVATAR_COLOURS[hashString(person?.id || name) % AVATAR_COLOURS.length];
  return h('span', { class: `avatar ${size}`.trim(), style: `background:${colour}`, 'aria-hidden': 'true' }, initials(name));
}

const time = (ts) => new Date(ts).getTime();
const dayKey = (ts) => new Date(ts).toDateString();

function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

function listTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clockTime(ts);
  const yesterday = new Date(); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (now - d < 6 * 24 * 60 * 60 * 1000) return d.toLocaleDateString([], { weekday: 'short' });
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

function appendLinkified(parent, text) {
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,!?;:)\]}'"]+$/, '');
    const start = match.index;
    if (start > last) parent.append(text.slice(last, start));
    parent.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
    last = start + url.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function setBusy(button, busy) {
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  button.disabled = busy;
}

function formMessage(form, kind, text) {
  const err = form.querySelector('.form-error');
  const ok = form.querySelector('.form-ok');
  if (err) { err.hidden = kind !== 'error'; if (kind === 'error') err.textContent = text; }
  if (ok) { ok.hidden = kind !== 'ok'; if (kind === 'ok') ok.textContent = text; }
}

const SCREENS = ['boot', 'screen-config', 'screen-login', 'screen-profile', 'screen-app'];
function showScreen(id) {
  for (const s of SCREENS) $(s).hidden = s !== id;
}

function showBootError(message) {
  showScreen('boot');
  $('boot-msg').textContent = message;
  $('boot-retry').hidden = false;
  $('boot-retry').onclick = () => location.reload();
}

function isNetworkError(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`;
  return /fetch|network|Failed to fetch|Load failed|AuthRetryableFetchError/i.test(text) || error?.status === 0;
}

function isMissingSchema(error) {
  return error?.code === 'PGRST205' || error?.code === '42P01' || error?.code === 'PGRST202'
    || /does not exist|Could not find the (table|function)/i.test(error?.message || '');
}

function explainLoadError(error) {
  if (isMissingSchema(error)) {
    return "Boom Boom's database isn't set up yet. Run supabase/schema.sql in the Supabase SQL Editor, then reload.";
  }
  if (isNetworkError(error)) {
    return "Can't reach the Boom Boom server. Check your connection. If it's been quiet for a week, the Supabase project may be paused: restore it from the Supabase dashboard.";
  }
  return `Something went wrong loading Boom Boom: ${error?.message || 'unknown error'}`;
}

function profileErrorText(error) {
  if (error?.code === '23505') return 'That username is taken. Try another.';
  if (error?.code === '23514') return 'Usernames are 3–20 characters: lowercase letters, numbers or _. Display names can be up to 40 characters.';
  if (isNetworkError(error)) return "Couldn't save. Check your connection and try again.";
  return error?.message || "Couldn't save your profile.";
}

// ---------------------------------------------------------------------
//  Configuration check
// ---------------------------------------------------------------------

function keyProblem(key) {
  if (key.startsWith('sb_secret_')) return 'secret';
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.role === 'service_role') return 'secret';
    } catch { /* not a JWT we can read; fine */ }
  }
  return null;
}

// (The check itself runs at the very bottom of this file, once everything
// it needs has been defined.)

// ---------------------------------------------------------------------
//  App state
// ---------------------------------------------------------------------

let supabase;
let currentUserId = null;
let pendingSeq = 0;

const state = {
  user: null,            // signed-in auth user
  me: null,              // my profile row
  profiles: new Map(),   // id -> { id, username, display_name }
  chats: [],             // rows from my_conversations()
  activeId: null,        // open conversation
  messages: new Map(),   // conversation id -> [message]
  hasMore: new Map(),    // conversation id -> boolean
  drafts: new Map(),     // conversation id -> unsent text
  seen: new Set(),       // message ids already counted
  pulse: null,           // conversation whose badge should ripple
  reactions: new Map(),  // message id -> Map(user id -> emoji)
  quoted: new Map(),     // message id -> message (originals of replies not on screen)
  replyTo: null,         // message being replied to in the open chat
  photoUrls: new Map(),  // storage path -> Promise<object URL>
  features: false,       // photos/reactions/replies/unsend set up on the server?
  channel: null,
  live: false,
  started: false,
};

function resetState() {
  for (const p of state.photoUrls.values()) p.then((url) => URL.revokeObjectURL(url), () => {});
  state.user = null;
  state.me = null;
  state.profiles = new Map();
  state.chats = [];
  state.activeId = null;
  state.messages = new Map();
  state.hasMore = new Map();
  state.drafts = new Map();
  state.seen = new Set();
  state.pulse = null;
  state.reactions = new Map();
  state.quoted = new Map();
  state.replyTo = null;
  state.photoUrls = new Map();
  state.features = false;
  state.live = false;
  state.started = false;
}

const msgColumns = () => (state.features ? MSG_COLUMNS_V2 : MSG_COLUMNS_V1);

// Has features.sql been run? (The app keeps working without it.)
async function detectFeatures() {
  const { error } = await supabase.from('messages').select('deleted_at').limit(1);
  state.features = !error;
  $('btn-attach').hidden = !state.features;
}

// ---------------------------------------------------------------------
//  Start-up and sign-in
// ---------------------------------------------------------------------

function start() {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  // Supabase recommends not awaiting other Supabase calls inside this
  // callback, so hand off to the next tick.
  supabase.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => handleSession(session), 0);
  });

  wireUi();
  wireInstallAndNotifications();
  registerServiceWorker();
}

async function handleSession(session) {
  const user = session?.user ?? null;

  if (!user) {
    stopApp();
    showScreen('screen-login');
    return;
  }
  if (user.id === currentUserId) return; // token refresh, nothing to do

  currentUserId = user.id;
  state.user = user;

  try {
    await loadProfiles();
  } catch (error) {
    currentUserId = null;
    showBootError(explainLoadError(error));
    return;
  }

  state.me = state.profiles.get(user.id) ?? null;
  if (!state.me) {
    openProfileSetup();
    return;
  }
  await startApp();
}

function openProfileSetup() {
  const form = $('profile-form');
  form.reset();
  formMessage(form, 'none');
  const suggestion = (state.user.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  if (suggestion.length >= 3) form.username.value = suggestion;
  showScreen('screen-profile');
  if (!isTouch) form.display_name.focus();
}

async function startApp() {
  state.started = true;
  showScreen('screen-app');
  closeChat({ quiet: true });
  await detectFeatures();
  await loadChats();
  subscribe();
  renderNudge();
  resyncNotifications();

  // Opened from a notification: go straight to that chat.
  const chatFromLink = new URLSearchParams(location.search).get('chat');
  if (chatFromLink) {
    history.replaceState(null, '', location.pathname);
    openChat(chatFromLink);
  }
}

function stopApp() {
  if (state.channel && supabase) supabase.removeChannel(state.channel);
  state.channel = null;
  currentUserId = null;
  resetState();
  for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close();
  $('chat-list').replaceChildren();
  $('message-list').replaceChildren();
  $('conn-banner').hidden = true;
  $('nudge').hidden = true;
  $('screen-app').classList.remove('show-chat');
  updateTitle();
}

// ---------------------------------------------------------------------
//  Loading data
// ---------------------------------------------------------------------

async function loadProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name')
    .order('display_name');
  if (error) throw error;
  state.profiles = new Map(data.map((p) => [p.id, p]));
}

async function loadChats() {
  const { data, error } = await supabase.rpc('my_conversations');
  if (error) {
    if (isMissingSchema(error)) showBootError(explainLoadError(error));
    else toast("Couldn't load your chats. Check your connection.");
    return;
  }
  const chats = data
    // A one-to-one chat with nobody left on the other side means that
    // person's account was deleted, so there's no one to talk to. Hide it.
    .filter((c) => c.is_group || c.other_user_id)
    .map((c) => ({ ...c, unread_count: Number(c.unread_count) || 0 }));
  // Keep a just-opened empty chat on screen even though the server list hides it.
  const local = state.chats.find((c) => c.local && c.conversation_id === state.activeId);
  if (local && !chats.some((c) => c.conversation_id === local.conversation_id)) chats.unshift(local);
  state.chats = chats;

  if (state.chats.some((c) => c.other_user_id && !state.profiles.has(c.other_user_id))) {
    await loadProfiles().catch(() => {});
  }

  // The chat you're looking at has nothing unread.
  const active = activeChat();
  if (active && document.visibilityState === 'visible' && active.unread_count > 0) {
    markRead(active.conversation_id);
  }
  renderChatList();
  updateTitle();
}

async function fetchLatest(convId) {
  const { data, error } = await supabase
    .from('messages')
    .select(msgColumns())
    .eq('conversation_id', convId)
    .order('id', { ascending: false })
    .limit(PAGE_SIZE);
  if (error) {
    toast("Couldn't load messages. Check your connection.");
    return false;
  }
  const list = data.reverse();
  list.forEach((m) => state.seen.add(m.id));
  // Keep anything still sending (or failed) from this device.
  const local = (state.messages.get(convId) || []).filter((m) => m.pending || m.failed);
  state.messages.set(convId, [...list, ...local]);
  state.hasMore.set(convId, data.length === PAGE_SIZE);
  await loadExtras(convId, list);
  return true;
}

async function fetchOlder(convId) {
  const list = state.messages.get(convId);
  const oldest = list?.find((m) => typeof m.id === 'number');
  if (!oldest) return;
  const { data, error } = await supabase
    .from('messages')
    .select(msgColumns())
    .eq('conversation_id', convId)
    .lt('id', oldest.id)
    .order('id', { ascending: false })
    .limit(PAGE_SIZE);
  if (error) {
    toast("Couldn't load earlier messages.");
    return;
  }
  data.forEach((m) => state.seen.add(m.id));
  list.unshift(...data.reverse());
  state.hasMore.set(convId, data.length === PAGE_SIZE);
  await loadExtras(convId, data);
}

// Reactions for these messages, and the originals of any replies among them.
async function loadExtras(convId, msgs) {
  if (!state.features || !msgs.length) return;
  const ids = msgs.map((m) => m.id).filter((id) => typeof id === 'number');
  const { data } = await supabase
    .from('message_reactions')
    .select('message_id, user_id, emoji')
    .eq('conversation_id', convId)
    .in('message_id', ids);
  for (const r of data || []) setReaction(r.message_id, r.user_id, r.emoji);
  await loadQuoted(convId, msgs);
}

async function loadQuoted(convId, msgs) {
  const have = new Set((state.messages.get(convId) || []).map((m) => m.id));
  const missing = [...new Set(msgs.map((m) => m.reply_to).filter((id) => id && !have.has(id) && !state.quoted.has(id)))];
  if (!missing.length) return;
  const { data } = await supabase.from('messages').select(MSG_COLUMNS_V2).in('id', missing);
  for (const m of data || []) state.quoted.set(m.id, m);
}

function setReaction(messageId, userId, emoji) {
  if (!state.reactions.has(messageId)) state.reactions.set(messageId, new Map());
  const map = state.reactions.get(messageId);
  if (emoji) map.set(userId, emoji);
  else map.delete(userId);
}

// Catch up on anything that arrived while the connection was down.
async function fetchNewer(convId) {
  const list = state.messages.get(convId);
  if (!list) return fetchLatest(convId);
  const real = list.filter((m) => typeof m.id === 'number');
  if (!real.length) return fetchLatest(convId);
  const newestId = real[real.length - 1].id;
  const { data, error } = await supabase
    .from('messages')
    .select(msgColumns())
    .eq('conversation_id', convId)
    .gt('id', newestId)
    .order('id', { ascending: true })
    .limit(200);
  if (error) return false;
  for (const m of data) {
    state.seen.add(m.id);
    if (!list.some((x) => x.id === m.id)) {
      dropMatchingPending(list, m);
      insertSorted(list, m);
    }
  }
  await loadExtras(convId, data);
  return true;
}

// ---------------------------------------------------------------------
//  Live delivery
// ---------------------------------------------------------------------

function subscribe() {
  if (state.channel) supabase.removeChannel(state.channel);
  let channel = supabase
    .channel('boom-inbox')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      onIncoming(payload.new);
    });
  if (state.features) {
    // Only rows you're allowed to see arrive (security rules apply to inserts
    // and updates, which is why unsend and reactions are updates, not deletes).
    channel = channel
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => onMessageUpdate(payload.new))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions' }, (payload) => onReaction(payload.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'message_reactions' }, (payload) => onReaction(payload.new));
  }
  state.channel = channel
    .subscribe((status) => {
      if (!state.started) return;
      if (status === 'SUBSCRIBED') {
        state.live = true;
        $('conn-banner').hidden = true;
        resync(); // fill any gap between loading and connecting
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        state.live = false;
        $('conn-banner').hidden = false;
      }
    });
}

let resyncing = false;
async function resync() {
  if (resyncing || !state.started) return;
  resyncing = true;
  try {
    await loadChats();
    if (state.activeId) {
      const id = state.activeId;
      await fetchNewer(id);
      if (state.activeId === id) {
        renderMessages();
        if (document.visibilityState === 'visible') markRead(id);
      }
    }
  } finally {
    resyncing = false;
  }
}

function onIncoming(m) {
  if (!state.started || state.seen.has(m.id)) return;
  state.seen.add(m.id);

  const mine = m.sender_id === state.user.id;
  const chat = state.chats.find((c) => c.conversation_id === m.conversation_id);

  if (!state.profiles.has(m.sender_id)) {
    loadProfiles().then(() => { renderChatList(); renderChatHeader(); }).catch(() => {});
  }

  // A chat we didn't know about (someone just messaged you for the first time).
  if (!chat) {
    if (!mine) state.pulse = m.conversation_id;
    loadChats();
    return;
  }

  const list = state.messages.get(m.conversation_id);
  if (list && !list.some((x) => x.id === m.id)) {
    if (mine) dropMatchingPending(list, m);
    insertSorted(list, m);
  }

  const viewing = m.conversation_id === state.activeId && document.visibilityState === 'visible';
  updateChatPreview(m, !mine && !viewing);

  if (m.conversation_id === state.activeId) {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    renderMessages(mine);
    if (!mine && !nearBottom) $('btn-jump').hidden = false;
    if (viewing) markRead(m.conversation_id);
    if (m.reply_to) loadQuoted(m.conversation_id, [m]).then(() => renderMessages());
  }

  if (!mine) {
    const name = state.profiles.get(m.sender_id)?.display_name || 'Someone';
    const what = m.photo_path ? 'sent a photo' : m.body;
    announce(m.conversation_id === state.activeId ? `${name}: ${what}` : `New message from ${name}`);
  }
}

// Someone unsent a message.
function onMessageUpdate(m) {
  if (!state.started) return;
  const list = state.messages.get(m.conversation_id);
  const existing = list?.find((x) => x.id === m.id);
  if (existing) Object.assign(existing, m);
  if (state.quoted.has(m.id)) state.quoted.set(m.id, m);
  if (m.deleted_at) state.reactions.delete(m.id);
  if (m.conversation_id === state.activeId) renderMessages();
  loadChats(); // the chat list preview may have changed
}

function onReaction(r) {
  if (!state.started) return;
  setReaction(r.message_id, r.user_id, r.emoji);
  if (r.conversation_id === state.activeId) renderMessages();
}

// For screen readers: say what arrived without re-reading the whole chat.
function announce(text) {
  const el = $('sr-live');
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 50);
}

// ---------------------------------------------------------------------
//  Message list bookkeeping
// ---------------------------------------------------------------------

// Real messages are ordered by id; messages still sending stay at the end.
function insertSorted(list, m) {
  let i = list.length;
  while (i > 0 && (list[i - 1].pending || list[i - 1].failed || list[i - 1].id > m.id)) i--;
  list.splice(i, 0, m);
}

function dropMatchingPending(list, m) {
  if (m.sender_id !== state.user.id) return;
  const i = m.photo_path
    ? list.findIndex((x) => (x.pending || x.failed) && x.photo_path === m.photo_path)
    : list.findIndex((x) => (x.pending || x.failed) && !x.upload && x.body === m.body);
  if (i !== -1) list.splice(i, 1);
}

function messageKind(m) {
  if (m.deleted_at) return 'unsent';
  if (m.photo_path) return 'photo';
  return 'text';
}

function updateChatPreview(m, countAsUnread) {
  const chat = state.chats.find((c) => c.conversation_id === m.conversation_id);
  if (!chat) return;
  chat.last_message_body = m.body;
  chat.last_message_sender = m.sender_id;
  chat.last_message_kind = messageKind(m);
  chat.last_message_at = m.created_at;
  if (countAsUnread) {
    chat.unread_count += 1;
    state.pulse = chat.conversation_id;
  }
  state.chats.sort((a, b) => time(b.last_message_at || 0) - time(a.last_message_at || 0));
  renderChatList();
  updateTitle();
}

function activeChat() {
  return state.chats.find((c) => c.conversation_id === state.activeId) || null;
}

function markRead(convId) {
  const chat = state.chats.find((c) => c.conversation_id === convId);
  if (chat && chat.unread_count) {
    chat.unread_count = 0;
    renderChatList();
    updateTitle();
  }
  supabase.rpc('mark_read', { conv: convId }).then(({ error }) => {
    if (error) console.warn('mark_read failed', error);
  });
  // Clear this chat's notifications now that you've seen it.
  swReg?.getNotifications?.({ tag: `chat-${convId}` })
    .then((list) => list.forEach((n) => n.close()))
    .catch(() => {});
}

function updateTitle() {
  const total = state.chats.reduce((sum, c) => sum + (c.unread_count || 0), 0);
  document.title = total ? `(${total}) Boom Boom` : 'Boom Boom';
  // Number on the app icon, where the phone supports it.
  try {
    if (total && navigator.setAppBadge) navigator.setAppBadge(total).catch(() => {});
    else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  } catch { /* not supported */ }
}

// ---------------------------------------------------------------------
//  Rendering
// ---------------------------------------------------------------------

function chatName(chat) {
  if (chat.is_group) return chat.title || 'Group';
  return state.profiles.get(chat.other_user_id)?.display_name || 'Someone';
}

function personName(userId) {
  if (userId === state.user?.id) return 'You';
  return state.profiles.get(userId)?.display_name || 'Someone';
}

function previewText(kind, body, senderId) {
  const mine = senderId === state.user?.id;
  const text = (body || '').replace(/\s+/g, ' ').trim();
  if (kind === 'unsent') return mine ? 'You unsent a message' : 'Message unsent';
  if (kind === 'photo') return (mine ? 'You: ' : '') + (text ? `📷 ${text}` : '📷 Photo');
  if (!text) return 'No messages yet';
  return (mine ? 'You: ' : '') + text;
}

// One line describing a message, for reply quotes.
function snippet(m) {
  if (!m) return 'Original message';
  if (m.deleted_at) return 'Message unsent';
  const text = (m.body || '').replace(/\s+/g, ' ').trim();
  if (m.photo_path) return text ? `📷 ${text}` : '📷 Photo';
  return text;
}

function findMessage(convId, id) {
  return (state.messages.get(convId) || []).find((m) => m.id === id) || state.quoted.get(id) || null;
}

function renderChatList() {
  const list = $('chat-list');
  list.replaceChildren();
  $('chat-list-empty').hidden = state.chats.length > 0;

  for (const chat of state.chats) {
    const other = state.profiles.get(chat.other_user_id);
    const name = chatName(chat);
    const unread = chat.unread_count > 0;
    const active = chat.conversation_id === state.activeId;
    const preview = previewText(chat.last_message_kind, chat.last_message_body, chat.last_message_sender);

    const badge = unread
      ? h('span', { class: 'badge', 'aria-label': `${chat.unread_count} unread` }, chat.unread_count > 99 ? '99+' : String(chat.unread_count))
      : null;

    list.append(h('li', {},
      h('button', {
        type: 'button',
        class: `chat-item${active ? ' active' : ''}${unread ? ' unread' : ''}`,
        'data-id': chat.conversation_id,
        'aria-current': active ? 'true' : null,
      },
      avatarEl(other ?? { id: chat.conversation_id, display_name: name }),
      h('span', { class: 'chat-item-main' },
        h('span', { class: 'chat-item-top' },
          h('span', { class: 'chat-item-name' }, name),
          h('time', { class: 'chat-item-time', datetime: chat.last_message_at || null }, listTime(chat.last_message_at))),
        h('span', { class: 'chat-item-bottom' },
          h('span', { class: 'chat-item-preview' }, preview),
          badge)))));

    if (badge && state.pulse === chat.conversation_id) {
      badge.classList.add('boom');
      badge.addEventListener('animationend', () => badge.classList.remove('boom'), { once: true });
    }
  }
  state.pulse = null;
}

function renderChatHeader() {
  const chat = activeChat();
  if (!chat) return;
  const other = state.profiles.get(chat.other_user_id);
  $('chat-avatar').replaceChildren(avatarEl(other ?? { id: chat.conversation_id, display_name: chatName(chat) }, 'sm'));
  $('chat-name').textContent = chatName(chat);
  $('chat-username').textContent = other ? `@${other.username}` : '';
}

function renderMessages(stickToBottom = false) {
  const box = $('messages');
  const list = $('message-list');
  const convId = state.activeId;
  if (!convId) return;
  const msgs = state.messages.get(convId) || [];
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;

  list.replaceChildren();
  if (!msgs.length) {
    list.append(h('p', { class: 'chat-start' }, `This is the start of your chat with ${chatName(activeChat() || {})}. Say hi.`));
  }

  msgs.forEach((m, i) => {
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const sameRun = (a, b) => a && b && a.sender_id === b.sender_id
      && dayKey(a.created_at) === dayKey(b.created_at)
      && Math.abs(time(b.created_at) - time(a.created_at)) < GROUP_GAP_MS;

    if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) {
      list.append(h('p', { class: 'day' }, dayLabel(m.created_at)));
    }
    list.append(messageEl(m, sameRun(prev, m), !sameRun(m, next)));
  });

  $('btn-older').hidden = !state.hasMore.get(convId);
  if (stickToBottom || wasNearBottom) {
    box.scrollTop = box.scrollHeight;
    $('btn-jump').hidden = true;
  }
}

function messageEl(m, grouped, tail) {
  const mine = m.sender_id === state.user.id;
  const side = mine ? 'mine' : 'theirs';
  const unsent = !!m.deleted_at;
  const local = m.pending || m.failed;

  const wrapClasses = ['msg-wrap', side];
  if (grouped) wrapClasses.push('grouped');
  const classes = ['msg', side];
  if (tail) classes.push('tail');
  if (m.pending) classes.push('pending');
  if (m.failed) classes.push('failed');
  if (unsent) classes.push('unsent');
  const photo = m.photo_thumb_path || m.photo_local;
  if (photo && !unsent) classes.push('has-photo');

  const bubble = h('div', { class: classes.join(' '), 'data-id': m.id });

  if (unsent) {
    bubble.append(h('span', { class: 'msg-body' }, mine ? 'You unsent a message' : `${personName(m.sender_id)} unsent a message`));
  } else {
    if (m.reply_to) {
      const original = findMessage(m.conversation_id, m.reply_to);
      bubble.append(h('button', {
        type: 'button',
        class: 'msg-quote',
        'aria-label': `Reply to ${original ? personName(original.sender_id) : 'a message'}: ${snippet(original)}. Show original.`,
        onclick: (e) => { e.stopPropagation(); jumpToMessage(m.reply_to); },
      },
      h('strong', {}, original ? personName(original.sender_id) : ''),
      h('span', {}, original ? snippet(original) : 'Loading…')));
    }
    if (photo) {
      const ratio = m.photo_width && m.photo_height ? `${m.photo_width} / ${m.photo_height}` : '4 / 3';
      const img = h('img', { alt: 'Photo', style: `aspect-ratio:${ratio}`, decoding: 'async' });
      if (m.photo_local) img.src = m.photo_local;
      else photoUrl(m.photo_thumb_path).then((url) => { img.src = url; }, () => { img.alt = "Photo couldn't load"; });
      bubble.append(h('button', {
        type: 'button',
        class: 'msg-photo',
        'aria-label': 'Open photo',
        onclick: (e) => { if (!local) { e.stopPropagation(); openViewer(m); } },
      }, img));
    }
    if (m.body) {
      const body = h('span', { class: 'msg-body' });
      appendLinkified(body, m.body);
      bubble.append(body);
    }
  }

  let meta = clockTime(m.created_at);
  if (m.pending) meta = m.upload || m.preparing ? 'Sending photo…' : 'Sending…';
  if (m.failed) meta = 'Not sent. Tap to retry.';
  bubble.append(h('span', { class: 'msg-meta' }, meta));

  const wrap = h('div', { class: wrapClasses.join(' '), 'data-id': m.id }, bubble);

  if (m.failed) {
    bubble.setAttribute('role', 'button');
    bubble.tabIndex = 0;
    bubble.addEventListener('click', () => retry(m));
    bubble.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); retry(m); } });
  } else if (!local && !unsent) {
    bubble.tabIndex = 0;
    attachMessageMenu(bubble, m);
    wrap.append(reactionsEl(m));
    wrap.append(h('button', {
      type: 'button', class: 'msg-more', 'aria-label': 'React, reply and more', title: 'React, reply and more',
      onclick: () => openMessageMenu(m),
    }, '⋯'));
  }
  return wrap;
}

function reactionsEl(m) {
  const map = state.reactions.get(m.id);
  const box = h('div', { class: 'msg-reactions' });
  if (!map || !map.size) return box;
  for (const emoji of REACTIONS) {
    const who = [...map].filter(([, e]) => e === emoji).map(([uid]) => uid);
    if (!who.length) continue;
    const mineToo = who.includes(state.user.id);
    const names = who.map(personName).join(', ');
    box.append(h('button', {
      type: 'button',
      class: `chip${mineToo ? ' mine' : ''}`,
      'aria-label': `${emoji} from ${names}${mineToo ? '. Tap to remove yours' : ''}`,
      title: names,
      onclick: () => react(m, emoji),
    }, emoji, who.length > 1 ? h('span', {}, String(who.length)) : null));
  }
  return box;
}

// Press and hold (phones), right-click or Enter (computers) opens the menu.
let suppressClickUntil = 0;
function attachMessageMenu(el, m) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    startX = e.clientX;
    startY = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      suppressClickUntil = Date.now() + 700;
      navigator.vibrate?.(10);
      openMessageMenu(m);
    }, 450);
  });
  el.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel();
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancel();
    suppressClickUntil = Date.now() + 700;
    openMessageMenu(m);
  });
  el.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  el.addEventListener('keydown', (e) => {
    if (e.target === el && (e.key === 'Enter' || e.key === ' ' || e.key === 'ContextMenu')) {
      e.preventDefault();
      openMessageMenu(m);
    }
  });
}

function jumpToMessage(id) {
  const el = $('message-list').querySelector(`.msg[data-id="${id}"]`);
  if (!el) {
    toast(state.hasMore.get(state.activeId) ? 'That message is further up. Tap "Show earlier messages".' : "That message isn't available.");
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth; // restart the highlight
  el.classList.add('flash');
}

// Photos are private: they're downloaded with your login, never via a public link.
function photoUrl(path) {
  if (!state.photoUrls.has(path)) {
    const p = supabase.storage.from('photos').download(path).then(({ data, error }) => {
      if (error || !data) throw error || new Error('download failed');
      return URL.createObjectURL(data);
    });
    p.catch(() => state.photoUrls.delete(path)); // allow a retry later
    state.photoUrls.set(path, p);
  }
  return state.photoUrls.get(path);
}

// ---------------------------------------------------------------------
//  Opening and closing chats
// ---------------------------------------------------------------------

async function openChat(convId) {
  if (state.activeId && state.activeId !== convId) {
    saveDraft();
    clearReply();
  }
  state.activeId = convId;

  if (!activeChat()) await loadChats();
  if (state.activeId !== convId) return;
  if (!activeChat()) {
    state.activeId = null;
    toast("That chat isn't available.");
    return;
  }

  $('conversation-empty').hidden = true;
  $('conversation-inner').hidden = false;
  $('screen-app').classList.add('show-chat');
  $('btn-jump').hidden = true;
  if (history.state?.chat) history.replaceState({ chat: convId }, '');
  else history.pushState({ chat: convId }, '');

  renderChatHeader();
  renderChatList();

  const input = $('composer-input');
  input.value = state.drafts.get(convId) || '';
  autosize();

  $('message-list').replaceChildren(h('p', { class: 'chat-start' }, 'Loading…'));
  $('btn-older').hidden = true;
  if (state.messages.has(convId)) await fetchNewer(convId);
  else await fetchLatest(convId);
  if (state.activeId !== convId) return;

  renderMessages(true);
  markRead(convId);
  if (!isTouch) input.focus();
}

function closeChat({ quiet = false } = {}) {
  if (state.activeId) saveDraft();
  clearReply();
  state.activeId = null;
  $('screen-app').classList.remove('show-chat');
  $('conversation-inner').hidden = true;
  $('conversation-empty').hidden = false;
  if (!quiet) renderChatList();
}

function saveDraft() {
  const text = $('composer-input').value;
  if (!state.activeId) return;
  if (text.trim()) state.drafts.set(state.activeId, text);
  else state.drafts.delete(state.activeId);
}

// ---------------------------------------------------------------------
//  Sending
// ---------------------------------------------------------------------

function autosize() {
  const input = $('composer-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight + 3, 160)}px`;
  $('btn-send').disabled = !input.value.trim();
}

function newTemp(convId, fields) {
  const temp = {
    id: `pending-${++pendingSeq}`,
    conversation_id: convId,
    sender_id: state.user.id,
    body: '',
    created_at: new Date().toISOString(),
    pending: true,
    reply_to: typeof state.replyTo?.id === 'number' ? state.replyTo.id : null,
    ...fields,
  };
  if (!state.messages.has(convId)) state.messages.set(convId, []);
  state.messages.get(convId).push(temp);
  return temp;
}

async function sendCurrent() {
  const convId = state.activeId;
  const input = $('composer-input');
  const body = input.value.trim();
  if (!convId || !body) return;

  input.value = '';
  autosize();
  state.drafts.delete(convId);

  const temp = newTemp(convId, { body });
  clearReply();
  renderMessages(true);
  await deliver(temp);
}

// Swap a sending message for the saved one.
function settle(temp, data, error) {
  const convId = temp.conversation_id;
  const list = state.messages.get(convId) || [];
  const index = list.indexOf(temp);
  if (error) {
    temp.pending = false;
    temp.failed = true;
    if (!isNetworkError(error)) console.warn('send failed', error);
  } else {
    state.seen.add(data.id);
    if (index !== -1) list.splice(index, 1);
    if (!list.some((m) => m.id === data.id)) insertSorted(list, data);
    updateChatPreview(data, false);
  }
  if (state.activeId === convId) renderMessages();
}

async function deliver(temp) {
  const row = { conversation_id: temp.conversation_id, body: temp.body };
  if (temp.reply_to) row.reply_to = temp.reply_to;
  const { data, error } = await supabase.from('messages').insert(row).select(msgColumns()).single();
  settle(temp, data, error);
}

function retry(m) {
  const list = state.messages.get(m.conversation_id);
  if (!list) return;
  const i = list.indexOf(m);
  if (i !== -1) list.splice(i, 1);
  m.failed = false;
  m.pending = true;
  list.push(m);
  renderMessages(true);
  if (m.upload) deliverPhoto(m);
  else deliver(m);
}

// ---------------------------------------------------------------------
//  Photos
// ---------------------------------------------------------------------

async function sendPhotos(files) {
  const convId = state.activeId;
  if (!convId || !files.length) return;
  const temps = [...files].map((file) => ({ file, temp: newTemp(convId, { preparing: true }) }));
  clearReply();
  renderMessages(true);
  for (const { file, temp } of temps) {
    try {
      // Strips location and camera details; keeps full quality (see photo.js).
      temp.upload = await preparePhoto(file);
      temp.preparing = false;
      temp.photo_local = URL.createObjectURL(temp.upload.thumb);
      temp.photo_width = temp.upload.width;
      temp.photo_height = temp.upload.height;
    } catch (error) {
      const list = state.messages.get(convId) || [];
      const i = list.indexOf(temp);
      if (i !== -1) list.splice(i, 1);
      if (state.activeId === convId) renderMessages();
      toast(error?.message || "Couldn't read that photo.");
      continue;
    }
    if (state.activeId === convId) renderMessages(true);
    await deliverPhoto(temp);
  }
}

async function deliverPhoto(temp) {
  const convId = temp.conversation_id;
  const id = crypto.randomUUID();
  const photoPath = `${convId}/${id}.${temp.upload.ext}`;
  const thumbPath = `${convId}/${id}-thumb.jpg`;
  temp.photo_path = photoPath;
  const bucket = supabase.storage.from('photos');
  const uploaded = [];
  let error = null;
  let data = null;
  try {
    const a = await bucket.upload(photoPath, temp.upload.original, { contentType: temp.upload.mime, upsert: false, cacheControl: '31536000' });
    if (a.error) throw a.error;
    uploaded.push(photoPath);
    const b = await bucket.upload(thumbPath, temp.upload.thumb, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
    if (b.error) throw b.error;
    uploaded.push(thumbPath);
    const row = {
      conversation_id: convId,
      body: '',
      photo_path: photoPath,
      photo_thumb_path: thumbPath,
      photo_width: temp.upload.width,
      photo_height: temp.upload.height,
    };
    if (temp.reply_to) row.reply_to = temp.reply_to;
    const res = await supabase.from('messages').insert(row).select(msgColumns()).single();
    if (res.error) throw res.error;
    data = res.data;
  } catch (e) {
    error = e;
    if (uploaded.length) bucket.remove(uploaded).catch(() => {}); // don't leave half-sent files behind
  }
  if (!error) {
    // Reuse the preview we already have instead of downloading it again.
    state.photoUrls.set(thumbPath, Promise.resolve(temp.photo_local));
  }
  settle(temp, data, error);
  if (error) toast(error?.statusCode === '413' || /exceeded|too large|size/i.test(error?.message || '')
    ? 'That photo is too big for the free storage plan.'
    : "Photo didn't send. Tap it to try again.");
}

// Full-size viewer.
async function openViewer(m) {
  const dlg = $('dlg-photo');
  const img = $('viewer-img');
  const save = $('viewer-save');
  const status = $('viewer-status');
  img.removeAttribute('src');
  save.hidden = true;
  status.hidden = false;
  status.textContent = 'Loading full photo…';
  dlg.showModal();
  try {
    img.src = await photoUrl(m.photo_thumb_path); // quick preview first
  } catch { /* the full photo below may still work */ }
  try {
    const url = await photoUrl(m.photo_path);
    if (!dlg.open) return;
    img.src = url;
    save.href = url;
    save.download = `boom-boom-${new Date(m.created_at).toISOString().slice(0, 10)}-${m.id}.${m.photo_path.split('.').pop()}`;
    save.hidden = false;
    status.hidden = true;
  } catch {
    status.textContent = "Couldn't load the full photo. Check your connection.";
  }
}

// ---------------------------------------------------------------------
//  Reactions, replies, unsend
// ---------------------------------------------------------------------

let menuMessage = null;
let unsendArmed = null;

function openMessageMenu(m) {
  const dlg = $('dlg-msg');
  if (dlg.open || m.deleted_at || m.pending || m.failed) return;
  menuMessage = m;
  const mine = m.sender_id === state.user.id;
  const myReaction = state.reactions.get(m.id)?.get(state.user.id) || null;

  const row = $('react-row');
  row.replaceChildren(...REACTIONS.map((emoji) => h('button', {
    type: 'button',
    class: `react${emoji === myReaction ? ' chosen' : ''}`,
    'aria-label': emoji === myReaction ? `Remove ${emoji}` : `React with ${emoji}`,
    'aria-pressed': emoji === myReaction ? 'true' : 'false',
    onclick: () => { dlg.close(); react(m, emoji); },
  }, emoji)));

  row.hidden = !state.features;
  $('act-reply').hidden = !state.features;
  $('act-copy').hidden = !m.body;
  $('act-photo').hidden = !m.photo_path;
  $('act-unsend').hidden = !state.features || !mine;
  resetUnsend();
  $('msg-preview').textContent = `${personName(m.sender_id)}: ${snippet(m)}`;
  dlg.showModal();
}

function resetUnsend() {
  clearTimeout(unsendArmed);
  unsendArmed = null;
  const b = $('act-unsend');
  b.textContent = 'Unsend';
  b.classList.remove('armed');
}

async function react(m, emoji) {
  if (!state.features) return;
  const current = state.reactions.get(m.id)?.get(state.user.id) || null;
  const next = current === emoji ? null : emoji;
  setReaction(m.id, state.user.id, next);
  renderMessages();
  const { error } = await supabase.rpc('react', { p_message_id: m.id, p_emoji: next });
  if (error) {
    setReaction(m.id, state.user.id, current);
    renderMessages();
    toast(/unsent/i.test(error.message) ? 'That message was unsent.' : "Couldn't add your reaction. Check your connection.");
  }
}

function startReply(m) {
  state.replyTo = m;
  $('reply-name').textContent = `Replying to ${m.sender_id === state.user.id ? 'yourself' : personName(m.sender_id)}`;
  $('reply-snippet').textContent = snippet(m);
  $('reply-bar').hidden = false;
  $('composer-input').focus();
}

function clearReply() {
  state.replyTo = null;
  $('reply-bar').hidden = true;
}

async function unsend(m) {
  const { data, error } = await supabase.rpc('unsend_message', { p_message_id: m.id });
  if (error) {
    toast(isNetworkError(error) ? "Couldn't unsend. Check your connection." : error.message);
    return;
  }
  // Delete the photo files themselves (the database only held their names).
  const files = (data || []).flatMap((r) => [r.photo_path, r.photo_thumb_path]).filter(Boolean);
  if (files.length) {
    const { error: removeError } = await supabase.storage.from('photos').remove(files);
    if (removeError) console.warn('Photo files not removed', removeError);
  }
  Object.assign(m, { body: '', photo_path: null, photo_thumb_path: null, deleted_at: new Date().toISOString() });
  state.reactions.delete(m.id);
  if (state.replyTo?.id === m.id) clearReply();
  renderMessages();
  loadChats();
}

// ---------------------------------------------------------------------
//  New chat
// ---------------------------------------------------------------------

async function openNewChat() {
  $('people-search').value = '';
  renderPeople('');
  $('dlg-new').showModal();
  if (!isTouch) $('people-search').focus();
  // Pick up anyone who joined since the app opened.
  try {
    await loadProfiles();
    renderPeople($('people-search').value);
  } catch { /* keep what we have */ }
}

function renderPeople(query) {
  const q = query.trim().toLowerCase();
  const everyone = [...state.profiles.values()].filter((p) => p.id !== state.user.id);
  const matches = everyone
    .filter((p) => !q || p.display_name.toLowerCase().includes(q) || p.username.includes(q))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  const list = $('people-list');
  list.replaceChildren();
  for (const p of matches) {
    list.append(h('li', {},
      h('button', { type: 'button', class: 'person', onclick: () => startChatWith(p.id) },
        avatarEl(p, 'sm'),
        h('span', {},
          h('span', { class: 'person-name' }, p.display_name),
          h('span', { class: 'person-handle' }, `@${p.username}`)))));
  }

  const empty = $('people-empty');
  empty.hidden = matches.length > 0;
  empty.textContent = everyone.length
    ? `No one matches "${query.trim()}".`
    : "No one else is here yet. Once your friends sign in and set up their profiles, they'll show up here.";
}

async function startChatWith(userId) {
  const { data: convId, error } = await supabase.rpc('get_or_create_dm', { other_user: userId });
  if (error) {
    toast(isNetworkError(error) ? "Couldn't start the chat. Check your connection." : error.message);
    return;
  }
  $('dlg-new').close();
  if (!state.chats.some((c) => c.conversation_id === convId)) await loadChats();
  if (!state.chats.some((c) => c.conversation_id === convId)) {
    // An empty chat the other person opened first: show it locally until someone writes.
    state.chats.unshift({
      conversation_id: convId, is_group: false, title: null, other_user_id: userId,
      last_message_at: null, last_message_body: null, last_message_sender: null,
      unread_count: 0, local: true,
    });
  }
  openChat(convId);
}

// ---------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------

function openSettings() {
  const form = $('settings-profile-form');
  form.display_name.value = state.me.display_name;
  form.username.value = state.me.username;
  formMessage(form, 'none');
  const pw = $('password-form');
  pw.reset();
  pw.username.value = state.user.email || '';
  formMessage(pw, 'none');
  $('settings-email').textContent = `Signed in as ${state.user.email}`;
  renderInstall();
  renderNotifySettings();
  $('dlg-settings').showModal();
}

// ---------------------------------------------------------------------
//  Installing the app, and notifications
// ---------------------------------------------------------------------

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(navigator.userAgent);
const NUDGE_KEY = 'boom-nudge-hidden-until';
let swReg = null;
let installEvent = null;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function bytesFromB64url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-chat' && e.data.conversation_id && state.started) openChat(e.data.conversation_id);
  });
  try {
    swReg = await navigator.serviceWorker.register('./sw.js');
  } catch (error) {
    console.warn('Service worker not registered', error);
  }
  if (state.started) {
    renderNudge();
    resyncNotifications();
  }
}

// 'ready' | 'not-configured' | 'ios-needs-install' | 'unsupported' | 'blocked'
function notifyState() {
  if (!VAPID_KEY) return 'not-configured';
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return isIOS && !isStandalone() ? 'ios-needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return 'ready';
}

async function currentPushSubscription() {
  if (!swReg?.pushManager) return null;
  try {
    return await swReg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

async function savePushSubscription(sub) {
  const json = sub.toJSON();
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys.p256dh,
    p_auth: json.keys.auth,
    p_user_agent: navigator.userAgent.slice(0, 300),
  });
  if (error) throw error;
}

async function enableNotifications() {
  const reg = swReg || await navigator.serviceWorker.ready;
  const options = { userVisibleOnly: true, applicationServerKey: bytesFromB64url(VAPID_KEY) };
  let sub;
  try {
    sub = await reg.pushManager.subscribe(options); // asks for permission if needed
  } catch (error) {
    if (error?.name !== 'InvalidStateError') throw error;
    // Subscribed with an old key: start fresh.
    const old = await reg.pushManager.getSubscription();
    if (old) await old.unsubscribe();
    sub = await reg.pushManager.subscribe(options);
  }
  try {
    await savePushSubscription(sub);
  } catch (error) {
    await sub.unsubscribe().catch(() => {});
    throw error;
  }
}

async function disableNotifications() {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe().catch(() => {});
}

// Before signing out: stop this device getting this account's notifications.
async function forgetThisDevice() {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint).then(() => {}, () => {});
}

// Keep the server's copy of this device up to date (e.g. after signing in again).
async function resyncNotifications() {
  if (!state.started || notifyState() !== 'ready' || Notification.permission !== 'granted') return;
  try {
    const sub = await currentPushSubscription();
    if (sub) await savePushSubscription(sub);
    else if (swReg) await enableNotifications(); // permission already given, so no prompt
  } catch (error) {
    console.warn('Could not refresh notifications', error);
  }
}

function notifyErrorText(error) {
  if (error?.name === 'NotAllowedError') return "Notifications weren't allowed. Tap the button again and choose Allow.";
  if (isMissingSchema(error)) return "Boom Boom's notification setup isn't finished on the server yet (push.sql).";
  if (isNetworkError(error)) return "Couldn't reach the server. Check your connection and try again.";
  return `Couldn't turn on notifications: ${error?.message || 'unknown error'}`;
}

async function renderNotifySettings() {
  const status = $('notify-status');
  const button = $('btn-notify');
  $('notify-error').hidden = true;
  button.hidden = true;

  const st = notifyState();
  if (st === 'not-configured') {
    status.textContent = "Notifications haven't been switched on for Boom Boom yet.";
  } else if (st === 'ios-needs-install') {
    status.textContent = 'On iPhone, notifications work once Boom Boom is on your Home Screen. Add it (see below), open it from there, then turn them on.';
  } else if (st === 'unsupported') {
    status.textContent = "This browser can't show notifications. Try Chrome, Edge, Firefox or Safari.";
  } else if (st === 'blocked') {
    status.textContent = "Notifications are blocked for Boom Boom. Allow them in your browser's site settings (or your phone's settings for the app), then come back here.";
  } else {
    const on = Notification.permission === 'granted' && !!(await currentPushSubscription());
    status.textContent = on
      ? "On for this device. You'll be notified when someone messages you and Boom Boom isn't open."
      : 'Get a notification when someone messages you, even when Boom Boom is closed.';
    button.textContent = on ? 'Turn off on this device' : 'Turn on notifications';
    button.className = on ? 'btn ghost' : 'btn primary';
    button.dataset.action = on ? 'off' : 'on';
    button.hidden = false;
  }
}

function renderInstall() {
  const status = $('install-status');
  const button = $('btn-install');
  button.hidden = true;
  if (isStandalone()) {
    status.textContent = "Boom Boom is installed. You're using the app right now.";
  } else if (installEvent) {
    status.textContent = 'Add Boom Boom to your home screen so it opens like any other app.';
    button.hidden = false;
  } else if (isIOS) {
    status.textContent = 'Tap the Share button (the square with an arrow), then Add to Home Screen. After that, open Boom Boom from your Home Screen.';
  } else if (isAndroid) {
    status.textContent = 'Open your browser menu (⋮) and choose Install app or Add to Home screen.';
  } else {
    status.textContent = "Use the install button in your browser's address bar or menu.";
  }
}

async function promptInstall() {
  if (!installEvent) return;
  const event = installEvent;
  installEvent = null;
  event.prompt();
  await event.userChoice.catch(() => {});
  renderInstall();
  renderNudge();
}

// A small banner in the chat list suggesting the next useful step.
async function renderNudge() {
  const el = $('nudge');
  if (!state.started) { el.hidden = true; return; }
  let hiddenUntil = 0;
  try { hiddenUntil = Number(localStorage.getItem(NUDGE_KEY)) || 0; } catch { /* private mode */ }

  let text = '';
  let label = '';
  let action = '';
  const st = notifyState();
  if (st === 'ready' && Notification.permission === 'default') {
    text = 'Get a buzz when friends message you, even with Boom Boom closed.';
    label = 'Turn on';
    action = 'notify';
  } else if (st === 'ios-needs-install') {
    text = 'Add Boom Boom to your Home Screen to get notifications on iPhone.';
    label = 'Show me';
    action = 'settings';
  } else if (installEvent && !isStandalone()) {
    text = 'Install Boom Boom so it opens like an app.';
    label = 'Install';
    action = 'install';
  }

  if (!action || Date.now() < hiddenUntil) { el.hidden = true; return; }
  $('nudge-text').textContent = text;
  const go = $('nudge-go');
  go.textContent = label;
  go.dataset.action = action;
  el.hidden = false;
}

function wireInstallAndNotifications() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own Install button instead
    installEvent = e;
    renderInstall();
    renderNudge();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    renderInstall();
    renderNudge();
    toast('Boom Boom is installed. Open it from your home screen.');
  });

  $('btn-install').addEventListener('click', promptInstall);

  $('btn-notify').addEventListener('click', async () => {
    const button = $('btn-notify');
    const turnOn = button.dataset.action === 'on';
    setBusy(button, true);
    try {
      if (turnOn) await enableNotifications();
      else await disableNotifications();
      await renderNotifySettings();
    } catch (error) {
      await renderNotifySettings();
      if (Notification.permission !== 'denied') { // if blocked, the status already explains
        const err = $('notify-error');
        err.textContent = notifyErrorText(error);
        err.hidden = false;
      }
    } finally {
      setBusy(button, false);
      renderNudge();
    }
  });

  $('nudge-go').addEventListener('click', async () => {
    const button = $('nudge-go');
    const action = button.dataset.action;
    if (action === 'install') return promptInstall();
    if (action === 'settings') {
      openSettings();
      $('install-section').scrollIntoView({ block: 'start' });
      return;
    }
    setBusy(button, true);
    try {
      await enableNotifications();
      toast("Notifications are on. You'll get a buzz when someone messages you.");
    } catch (error) {
      toast(notifyErrorText(error));
    } finally {
      setBusy(button, false);
      renderNudge();
    }
  });

  $('nudge-later').addEventListener('click', () => {
    try { localStorage.setItem(NUDGE_KEY, String(Date.now() + 7 * 24 * 60 * 60 * 1000)); } catch { /* private mode */ }
    $('nudge').hidden = true;
  });
}

function readProfileForm(form) {
  const display_name = form.display_name.value.trim();
  const username = form.username.value.trim().toLowerCase();
  if (!display_name) return { error: 'Enter a display name.' };
  if (display_name.length > 40) return { error: 'Display names can be up to 40 characters.' };
  if (!USERNAME_RE.test(username)) return { error: 'Usernames are 3–20 characters: lowercase letters, numbers or _.' };
  return { display_name, username };
}

// ---------------------------------------------------------------------
//  Wiring up the page
// ---------------------------------------------------------------------

function wireUi() {
  // Sign in
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) {
      formMessage(form, 'error', 'Enter your email and password.');
      return;
    }
    formMessage(form, 'none');
    setBusy(button, true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(button, false);
    if (!error) {
      form.reset();
      return;
    }
    let text = error.message;
    if (/invalid login credentials/i.test(error.message)) text = "That email and password don't match. Check them and try again.";
    else if (/email not confirmed/i.test(error.message)) text = 'This account isn’t confirmed yet. Ask the person who runs Boom Boom to confirm it in Supabase.';
    else if (isNetworkError(error)) text = "Can't reach the server. Check your connection, then try again.";
    formMessage(form, 'error', text);
  });

  // First-time profile
  const profileForm = $('profile-form');
  profileForm.username.addEventListener('input', (e) => { e.target.value = e.target.value.toLowerCase(); });
  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = profileForm.querySelector('button[type="submit"]');
    const values = readProfileForm(profileForm);
    if (values.error) {
      formMessage(profileForm, 'error', values.error);
      return;
    }
    setBusy(button, true);
    const { data, error } = await supabase
      .from('profiles')
      .insert({ id: state.user.id, ...values })
      .select('id, username, display_name')
      .single();
    setBusy(button, false);
    if (error) {
      formMessage(profileForm, 'error', profileErrorText(error));
      return;
    }
    state.profiles.set(data.id, data);
    state.me = data;
    await startApp();
  });
  $('profile-signout').addEventListener('click', async () => {
    await forgetThisDevice();
    await supabase.auth.signOut();
  });

  // Chat list
  $('chat-list').addEventListener('click', (e) => {
    const item = e.target.closest('.chat-item');
    if (item) openChat(item.dataset.id);
  });
  $('btn-new').addEventListener('click', openNewChat);
  $('btn-new-empty').addEventListener('click', openNewChat);
  $('btn-settings').addEventListener('click', openSettings);

  // Conversation
  $('btn-back').addEventListener('click', () => {
    if (history.state?.chat) history.back();
    else closeChat();
  });
  window.addEventListener('popstate', (e) => {
    if (!state.started) return;
    if (e.state?.chat) openChat(e.state.chat);
    else if (state.activeId) closeChat();
  });

  $('btn-older').addEventListener('click', async () => {
    const convId = state.activeId;
    const box = $('messages');
    const before = box.scrollHeight;
    const button = $('btn-older');
    setBusy(button, true);
    await fetchOlder(convId);
    setBusy(button, false);
    if (state.activeId !== convId) return;
    renderMessages();
    box.scrollTop += box.scrollHeight - before; // keep your place
  });

  $('btn-jump').addEventListener('click', () => {
    const box = $('messages');
    box.scrollTop = box.scrollHeight;
    $('btn-jump').hidden = true;
  });
  $('messages').addEventListener('scroll', () => {
    const box = $('messages');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 60) $('btn-jump').hidden = true;
  }, { passive: true });

  const input = $('composer-input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    // Enter sends on computers; on phones Enter makes a new line and the button sends.
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.isComposing) {
      e.preventDefault();
      sendCurrent();
    }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendCurrent();
    if (isTouch) input.focus(); // keep the keyboard up
  });

  // New chat sheet
  $('people-search').addEventListener('input', (e) => renderPeople(e.target.value));

  // Settings sheet
  const settingsForm = $('settings-profile-form');
  settingsForm.username.addEventListener('input', (e) => { e.target.value = e.target.value.toLowerCase(); });
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = settingsForm.querySelector('button[type="submit"]');
    const values = readProfileForm(settingsForm);
    if (values.error) {
      formMessage(settingsForm, 'error', values.error);
      return;
    }
    setBusy(button, true);
    const { data, error } = await supabase
      .from('profiles')
      .update(values)
      .eq('id', state.user.id)
      .select('id, username, display_name')
      .single();
    setBusy(button, false);
    if (error) {
      formMessage(settingsForm, 'error', profileErrorText(error));
      return;
    }
    state.profiles.set(data.id, data);
    state.me = data;
    formMessage(settingsForm, 'ok', 'Profile saved.');
    renderChatList();
  });

  const pwForm = $('password-form');
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = pwForm.querySelector('button[type="submit"]');
    const password = pwForm.password.value;
    if (password.length < 8) {
      formMessage(pwForm, 'error', 'Use at least 8 characters.');
      return;
    }
    if (password !== pwForm.confirm.value) {
      formMessage(pwForm, 'error', "The two passwords don't match.");
      return;
    }
    setBusy(button, true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(button, false);
    if (error) {
      formMessage(pwForm, 'error', isNetworkError(error) ? "Couldn't change it. Check your connection." : error.message);
      return;
    }
    pwForm.reset();
    formMessage(pwForm, 'ok', 'Password changed.');
  });

  $('btn-signout').addEventListener('click', async () => {
    $('dlg-settings').close();
    await forgetThisDevice();
    await supabase.auth.signOut();
  });

  // Photos
  $('btn-attach').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = ''; // so picking the same photo again still works
    sendPhotos(files);
  });

  // Reply bar
  $('btn-reply-cancel').addEventListener('click', clearReply);

  // Message menu
  $('act-reply').addEventListener('click', () => {
    $('dlg-msg').close();
    if (menuMessage) startReply(menuMessage);
  });
  $('act-copy').addEventListener('click', async () => {
    $('dlg-msg').close();
    try {
      await navigator.clipboard.writeText(menuMessage?.body || '');
      toast('Copied.');
    } catch {
      toast("Couldn't copy on this device.");
    }
  });
  $('act-photo').addEventListener('click', () => {
    $('dlg-msg').close();
    if (menuMessage) openViewer(menuMessage);
  });
  $('act-unsend').addEventListener('click', () => {
    const button = $('act-unsend');
    if (!unsendArmed) {
      // Ask once more, right here: unsending can't be undone.
      button.textContent = 'Tap again to unsend for everyone';
      button.classList.add('armed');
      unsendArmed = setTimeout(resetUnsend, 4000);
      return;
    }
    resetUnsend();
    $('dlg-msg').close();
    if (menuMessage) unsend(menuMessage);
  });
  $('dlg-msg').addEventListener('close', resetUnsend);

  // Photo viewer
  $('dlg-photo').addEventListener('click', (e) => {
    if (e.target === $('dlg-photo') || e.target.closest('[data-close]')) $('dlg-photo').close();
  });

  // Close sheets with the × button or by tapping outside them
  for (const dlg of document.querySelectorAll('dialog.sheet')) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  }

  // Coming back to the tab: catch up and clear what you've now seen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.started) resync();
  });
  window.addEventListener('online', () => { if (state.started) resync(); });
}

// ---------------------------------------------------------------------
//  Go
// ---------------------------------------------------------------------

const configured = SUPABASE_URL && SUPABASE_KEY
  && !SUPABASE_URL.includes('YOUR-') && !SUPABASE_KEY.includes('YOUR-');

if (!configured) {
  showScreen('screen-config');
} else if (keyProblem(SUPABASE_KEY) === 'secret') {
  showScreen('screen-config');
  $('config-msg').textContent = "config.js contains your Supabase SECRET key. Remove it now and use the publishable key instead. If this page is already on GitHub, rotate (regenerate) the secret key in Supabase: anyone who saw it could read every message.";
} else {
  start();
}
