// Boom Boom — private messaging for a group of friends.
// Front end only: Supabase stores the messages, checks who's allowed to read
// them, and pushes new ones to everyone live.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

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
const AVATAR_COLOURS = ['#3346B8','#C8174B', '#0F7B6C', '#9A4A00', '#6A3FB5', '#2F6E1F', '#B0306E', '#1F6F9F'];

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
  channel: null,
  live: false,
  started: false,
};

function resetState() {
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
  state.live = false;
  state.started = false;
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
  await loadChats();
  subscribe();
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
  const chats = data.map((c) => ({ ...c, unread_count: Number(c.unread_count) || 0 }));
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
    .select('id, conversation_id, sender_id, body, created_at')
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
  return true;
}

async function fetchOlder(convId) {
  const list = state.messages.get(convId);
  const oldest = list?.find((m) => typeof m.id === 'number');
  if (!oldest) return;
  const { data, error } = await supabase
    .from('messages')
    .select('id, conversation_id, sender_id, body, created_at')
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
    .select('id, conversation_id, sender_id, body, created_at')
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
  return true;
}

// ---------------------------------------------------------------------
//  Live delivery
// ---------------------------------------------------------------------

function subscribe() {
  if (state.channel) supabase.removeChannel(state.channel);
  state.channel = supabase
    .channel('boom-inbox')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      onIncoming(payload.new);
    })
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
  }

  if (!mine) {
    const name = state.profiles.get(m.sender_id)?.display_name || 'Someone';
    announce(m.conversation_id === state.activeId ? `${name}: ${m.body}` : `New message from ${name}`);
  }
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
  const i = list.findIndex((x) => (x.pending || x.failed) && x.body === m.body);
  if (i !== -1) list.splice(i, 1);
}

function updateChatPreview(m, countAsUnread) {
  const chat = state.chats.find((c) => c.conversation_id === m.conversation_id);
  if (!chat) return;
  chat.last_message_body = m.body;
  chat.last_message_sender = m.sender_id;
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
}

function updateTitle() {
  const total = state.chats.reduce((sum, c) => sum + (c.unread_count || 0), 0);
  document.title = total ? `(${total}) Boom Boom` : 'Boom Boom';
}

// ---------------------------------------------------------------------
//  Rendering
// ---------------------------------------------------------------------

function chatName(chat) {
  if (chat.is_group) return chat.title || 'Group';
  return state.profiles.get(chat.other_user_id)?.display_name || 'Someone';
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
    let preview = 'No messages yet';
    if (chat.last_message_body) {
      preview = (chat.last_message_sender === state.user?.id ? 'You: ' : '') + chat.last_message_body.replace(/\s+/g, ' ');
    }

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
  const classes = ['msg', mine ? 'mine' : 'theirs'];
  if (grouped) classes.push('grouped');
  if (tail) classes.push('tail');
  if (m.pending) classes.push('pending');
  if (m.failed) classes.push('failed');

  const body = h('span', { class: 'msg-body' });
  appendLinkified(body, m.body);

  let meta = clockTime(m.created_at);
  if (m.pending) meta = 'Sending…';
  if (m.failed) meta = 'Not sent. Tap to retry.';

  const el = h('div', { class: classes.join(' ') }, body, h('span', { class: 'msg-meta' }, meta));
  if (m.failed) {
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('click', () => retry(m));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); retry(m); } });
  }
  return el;
}

// ---------------------------------------------------------------------
//  Opening and closing chats
// ---------------------------------------------------------------------

async function openChat(convId) {
  if (state.activeId && state.activeId !== convId) saveDraft();
  state.activeId = convId;

  if (!activeChat()) await loadChats();
  if (state.activeId !== convId) return;

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

async function sendCurrent() {
  const convId = state.activeId;
  const input = $('composer-input');
  const body = input.value.trim();
  if (!convId || !body) return;

  input.value = '';
  autosize();
  state.drafts.delete(convId);

  const temp = {
    id: `pending-${++pendingSeq}`,
    conversation_id: convId,
    sender_id: state.user.id,
    body,
    created_at: new Date().toISOString(),
    pending: true,
  };
  if (!state.messages.has(convId)) state.messages.set(convId, []);
  state.messages.get(convId).push(temp);
  renderMessages(true);
  await deliver(temp);
}

async function deliver(temp) {
  const convId = temp.conversation_id;
  const { data, error } = await supabase
    .from('messages')
    .insert({ conversation_id: convId, body: temp.body })
    .select('id, conversation_id, sender_id, body, created_at')
    .single();

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

function retry(m) {
  const list = state.messages.get(m.conversation_id);
  if (!list) return;
  const i = list.indexOf(m);
  if (i !== -1) list.splice(i, 1);
  m.failed = false;
  m.pending = true;
  list.push(m);
  renderMessages(true);
  deliver(m);
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
  $('dlg-settings').showModal();
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
  $('profile-signout').addEventListener('click', () => supabase.auth.signOut());

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
    await supabase.auth.signOut();
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
