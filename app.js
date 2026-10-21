// Boom Boom — private messaging for a group of friends.
// Front end only: Supabase stores the messages, checks who's allowed to read
// them, and pushes new ones to everyone live. A small service worker (sw.js)
// shows notifications when the app is closed.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import * as config from './config.js';
import { preparePhoto, makeAvatar, makeWallpaper } from './photo.js';
import { Editor, COLOURS, BRUSHES, photoItem, blankItem, isEdited, exportItem, releasePreview, paint } from './editor.js';

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
const MSG_COLUMNS_V4 = `${MSG_COLUMNS_V2}, edited_at`;
const MSG_COLUMNS_V6 = `${MSG_COLUMNS_V4}, album, file_path, file_name, file_size, file_type, sticker_path`;
// Chat colours: bubbles, send button and accents (all pass contrast with white text).
const THEMES = {
  hibiscus: '#C8174B', ocean: '#1F5FCC', jungle: '#1D7A4C', sunset: '#C2410C',
  grape: '#6D3FC0', indigo: '#3346B8', rose: '#B4236E', teal: '#0F766E',
};
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
  const name = state.nicknames.get(person?.id) || person?.display_name || '?';
  const colour = AVATAR_COLOURS[hashString(person?.id || name) % AVATAR_COLOURS.length];
  const el = h('span', { class: `avatar ${size}`.trim(), style: `background:${colour}`, 'aria-hidden': 'true' }, initials(name));
  if (state.avatars && person?.avatar_path) {
    // Initials show until the picture arrives (or if it can't load).
    const img = h('img', { alt: '', decoding: 'async' });
    blobUrl('avatars', person.avatar_path).then((url) => { img.src = url; }, () => img.remove());
    el.append(img);
  }
  return el;
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

// *bold*, _italic_ and ~strikethrough~, like WhatsApp. Markers must sit at
// word edges, so snake_case, 2*3*4 and web links are left alone.
const STYLE_TAGS = { '*': 'strong', _: 'em', '~': 's' };
const isWordChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);

function appendStyled(parent, text) {
  const re = /([*_~])(\S(?:[^\n]*?\S)?)\1/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (isWordChar(text[start - 1]) || isWordChar(text[end]) || text[start - 1] === m[1]) {
      re.lastIndex = start + 1;
      continue;
    }
    if (start > last) parent.append(text.slice(last, start));
    const el = document.createElement(STYLE_TAGS[m[1]]);
    appendStyled(el, m[2]); // styles can be combined, e.g. *_both_*
    parent.append(el);
    last = end;
  }
  if (last < text.length) parent.append(text.slice(last));
}

// The same text with the style markers removed (for previews).
function plainText(text) {
  const span = document.createElement('span');
  appendStyled(span, text || '');
  return span.textContent;
}

function appendLinkified(parent, text) {
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,!?;:)\]}'"]+$/, '');
    const start = match.index;
    if (start > last) appendStyled(parent, text.slice(last, start));
    parent.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
    last = start + url.length;
  }
  if (last < text.length) appendStyled(parent, text.slice(last));
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
  photoUrls: new Map(),  // "bucket:path" -> Promise<object URL>
  features: false,       // photos/reactions/replies/unsend set up on the server?
  avatars: false,        // profile pictures + delete chat set up on the server?
  extras: false,         // typing, edit, chat colours set up on the server?
  editing: null,         // message being edited
  later: false,          // send later + nicknames set up on the server?
  nicknames: new Map(),  // user id -> your private nickname for them
  scheduled: new Map(),  // conversation id -> [your waiting scheduled messages]
  media: false,          // albums, files, stickers, wallpapers set up on the server?
  stickers: [],          // your sticker tray: [{ id, path }]
  wallpapers: new Map(), // conversation id -> 'pattern:dots' or 'photo:<file>'
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
  state.avatars = false;
  state.extras = false;
  state.editing = null;
  state.editDraft = '';
  state.later = false;
  state.nicknames = new Map();
  state.scheduled = new Map();
  state.media = false;
  state.stickers = [];
  state.wallpapers = new Map();
  state.live = false;
  state.started = false;
}

const msgColumns = () => (state.media ? MSG_COLUMNS_V6 : state.extras ? MSG_COLUMNS_V4 : state.features ? MSG_COLUMNS_V2 : MSG_COLUMNS_V1);

// Which setup files have been run? (The app keeps working without them.)
async function detectFeatures() {
  const [v2, v3, v4, v5, v6] = await Promise.all([
    supabase.from('messages').select('deleted_at').limit(1),
    supabase.from('profiles').select('avatar_path').limit(1),
    supabase.from('messages').select('edited_at').limit(1),
    supabase.from('nicknames').select('target_id').limit(1),
    supabase.from('stickers').select('id').limit(1),
  ]);
  // Each setup file builds on the one before it.
  state.features = !v2.error;
  state.avatars = state.features && !v3.error;
  state.extras = state.avatars && !v4.error;
  state.later = state.extras && !v5.error;
  state.media = state.later && !v6.error;
  $('btn-attach').hidden = !state.features;
  $('btn-chat-menu').hidden = !state.avatars && !state.extras;
  $('chat-delete-section').hidden = !state.avatars;
  $('chat-colour-section').hidden = !state.extras;
  $('avatar-edit').hidden = !state.avatars;
  $('privacy-section').hidden = !state.extras;
  $('chat-nickname-section').hidden = !state.later;
  $('tips-section').hidden = !state.features;
  $('tip-later').hidden = !state.later;
  $('tip-nickname').hidden = !state.later;
  $('tip-media').hidden = !state.features;
  $('att-sticker').hidden = !state.media;
  $('att-file').hidden = !state.media;
  $('chat-wall-section').hidden = !state.media;
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
  wireProfilePictureAndChatOptions();
  wireExtras();
  wireLaterAndNicknames();
  wireMedia();
  registerServiceWorker();
  initAutoUpdate();
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
    await detectFeatures();
    await loadProfiles();
    await loadNicknames();
    await loadWallpapers();
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
  restoreDraftsAfterUpdate();
  await loadChats();
  subscribe();
  renderNudge();
  resyncNotifications();
  loadMemory();
  setTimeout(maybeShowWhatsNew, 700);

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
  $('memory-card').hidden = true;
  $('screen-app').classList.remove('show-chat');
  updateTitle();
}

// ---------------------------------------------------------------------
//  Loading data
// ---------------------------------------------------------------------

async function loadProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select(['id, username, display_name', state.avatars && 'avatar_path', state.extras && 'share_typing'].filter(Boolean).join(', '))
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

  if (state.extras) {
    const { data: themes } = await supabase.from('conversations').select('id, theme');
    const byId = new Map((themes || []).map((t) => [t.id, t.theme]));
    for (const c of state.chats) c.theme = byId.get(c.conversation_id) || null;
    applyTheme();
  }

  if (state.chats.some((c) => c.other_user_id && !state.profiles.has(c.other_user_id))) {
    await loadProfiles().catch(() => {});
  }
  saveNicknamesForNotifications();

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
    .gt('created_at', clearedAt(convId))
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
    .gt('created_at', clearedAt(convId))
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
  const { data } = await supabase.from('messages').select(msgColumns()).in('id', missing);
  const since = time(clearedAt(convId));
  for (const m of data || []) {
    if (time(m.created_at) > since) state.quoted.set(m.id, m); // deleted-chat history stays hidden
  }
}

// Messages from before you deleted a chat stay hidden.
function clearedAt(convId) {
  return state.chats.find((c) => c.conversation_id === convId)?.cleared_at || '1970-01-01T00:00:00Z';
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
    .gt('created_at', clearedAt(convId))
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
  if (state.avatars) {
    channel = channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (payload) => onProfileUpdate(payload.new));
  }
  if (state.extras) {
    channel = channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, (payload) => onConversationUpdate(payload.new));
  }
  if (state.later) {
    channel = channel
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'scheduled_messages' }, (payload) => onScheduledChange(payload.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'scheduled_messages' }, (payload) => onScheduledChange(payload.new));
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
    await loadNicknames();
    await loadWallpapers();
    await loadChats();
    if (state.activeId) {
      const id = state.activeId;
      await fetchNewer(id);
      await loadScheduled(id);
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
    if (!mine && typingUntil) { typingUntil = 0; renderChatHeader(); }
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    renderMessages(mine);
    if (!mine && !nearBottom) $('btn-jump').hidden = false;
    if (viewing) markRead(m.conversation_id);
    if (m.reply_to) loadQuoted(m.conversation_id, [m]).then(() => renderMessages());
  }

  if (!mine) {
    const name = shownName(m.sender_id);
    const what = m.photo_path ? 'sent a photo' : m.file_path ? `sent a file, ${m.file_name}` : m.sticker_path ? 'sent a sticker' : plainText(m.body);
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

// A friend changed their name or picture.
function onProfileUpdate(p) {
  if (!state.started || !p?.id) return;
  const merged = { ...(state.profiles.get(p.id) || {}), ...p };
  state.profiles.set(p.id, merged);
  if (p.id === state.user.id) state.me = merged;
  renderChatList();
  renderChatHeader();
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
  if (Array.isArray(m.album)) return 'album';
  if (m.photo_path) return 'photo';
  if (m.file_path) return 'file';
  if (m.sticker_path) return 'sticker';
  return 'text';
}

function updateChatPreview(m, countAsUnread) {
  const chat = state.chats.find((c) => c.conversation_id === m.conversation_id);
  if (!chat) return;
  chat.last_message_body = m.file_path ? m.file_name : m.body;
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

// Your nickname for someone if you've set one, otherwise their own name.
function shownName(userId) {
  return state.nicknames.get(userId) || state.profiles.get(userId)?.display_name || 'Someone';
}

function chatName(chat) {
  if (chat.is_group) return chat.title || 'Group';
  return shownName(chat.other_user_id);
}

function personName(userId) {
  if (userId === state.user?.id) return 'You';
  return shownName(userId);
}

function previewText(kind, body, senderId) {
  const mine = senderId === state.user?.id;
  const text = plainText(body).replace(/\s+/g, ' ').trim();
  if (kind === 'unsent') return mine ? 'You unsent a message' : 'Message unsent';
  if (kind === 'photo') return (mine ? 'You: ' : '') + (text ? `📷 ${text}` : '📷 Photo');
  if (kind === 'album') return (mine ? 'You: ' : '') + (text ? `📷 ${text}` : '📷 Photos');
  if (kind === 'file') return (mine ? 'You: ' : '') + `📎 ${(body || 'File').replace(/\s+/g, ' ')}`;
  if (kind === 'sticker') return mine ? 'You sent a sticker' : 'Sticker';
  if (!text) return 'No messages yet';
  return (mine ? 'You: ' : '') + text;
}

// One line describing a message, for reply quotes.
function snippet(m) {
  if (!m) return 'Original message';
  if (m.deleted_at) return 'Message unsent';
  const text = plainText(m.body).replace(/\s+/g, ' ').trim();
  const album = Array.isArray(m.album) ? m.album.length : 0;
  if (album > 1) return text ? `📷 ${album} photos: ${text}` : `📷 ${album} photos`;
  if (m.photo_path) return text ? `📷 ${text}` : '📷 Photo';
  if (m.file_path || m.file_local) return `📎 ${m.file_name || 'File'}`;
  if (m.sticker_path) return 'Sticker';
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
  const typing = typingUntil > Date.now();
  const nick = state.nicknames.get(chat.other_user_id);
  $('chat-username').textContent = typing ? 'typing…'
    : other ? (nick ? `${other.display_name} (@${other.username})` : `@${other.username}`) : '';
  $('chat-username').classList.toggle('typing', typing);
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

  const waiting = state.scheduled.get(convId) || [];
  if (waiting.length) {
    list.append(h('p', { class: 'day' }, 'Scheduled'));
    for (const sm of waiting) list.append(scheduledEl(sm));
  }

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
  const albumCount = m.album_local ? m.album_local.length : Array.isArray(m.album) ? m.album.length : 0;
  const photo = !albumCount && (m.photo_thumb_path || m.photo_local);
  const isFile = !!(m.file_path || m.file_local);
  if ((photo || albumCount) && !unsent) classes.push('has-photo');
  if (albumCount && !unsent) classes.push('has-album');
  if (isFile && !unsent) classes.push('has-file');
  if (m.sticker_path && !unsent) classes.push('sticker');

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
        onclick: (e) => { if (!local) { e.stopPropagation(); tapped(m, bubble, () => openViewer(m)); } },
      }, img));
    }
    if (albumCount) bubble.append(albumEl(m, bubble, local));
    if (isFile) bubble.append(fileCardEl(m, bubble, local));
    if (m.sticker_path) bubble.append(stickerImgEl(m.sticker_path));
    if (m.body) {
      const body = h('span', { class: 'msg-body' });
      appendLinkified(body, m.body);
      bubble.append(body);
    }
  }

  let meta = clockTime(m.created_at) + (m.edited_at && !unsent ? ' (edited)' : '');
  if (m.pending) {
    meta = m.album_local ? 'Sending photos…' : m.upload || m.preparing ? 'Sending photo…' : m.fileBlob ? 'Sending file…' : 'Sending…';
  }
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
  let swipe = 0;     // how far it's been dragged right (swipe to reply)
  let swiping = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const endSwipe = (reply) => {
    if (!swiping) return;
    const wrap = el.parentElement;
    wrap?.classList.remove('swiping', 'swipe-ready');
    if (wrap) wrap.style.transform = '';
    swiping = false;
    suppressClickUntil = Date.now() + 300;
    if (reply && swipe > 60) startReply(m);
    swipe = 0;
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    startX = e.clientX;
    startY = e.clientY;
    swipe = 0;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      suppressClickUntil = Date.now() + 700;
      navigator.vibrate?.(10);
      openMessageMenu(m);
    }, 450);
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (timer && Math.hypot(dx, dy) > 10) cancel();
    if (!swiping && state.features && dx > 12 && Math.abs(dy) < 10) {
      swiping = true;
      try { el.setPointerCapture(e.pointerId); } catch { /* fine */ }
      el.parentElement?.classList.add('swiping');
    }
    if (swiping) {
      swipe = Math.max(0, Math.min(dx, 90));
      const wrap = el.parentElement;
      if (wrap) wrap.style.transform = `translateX(${swipe}px)`;
      wrap?.classList.toggle('swipe-ready', swipe > 60);
    }
  });
  el.addEventListener('pointerup', () => { cancel(); endSwipe(true); });
  el.addEventListener('pointercancel', () => { cancel(); endSwipe(false); });
  // Double-tap (or double-click) for ❤️; no text selection on double-click.
  el.addEventListener('mousedown', (e) => { if (e.detail > 1) e.preventDefault(); });
  el.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.target.closest('a')) return;
    tapped(m, el, null);
  });
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

// Photos and profile pictures are private: they're downloaded with your
// login, never through a public link.
function blobUrl(bucket, path) {
  const key = `${bucket}:${path}`;
  if (!state.photoUrls.has(key)) {
    const p = supabase.storage.from(bucket).download(path).then(({ data, error }) => {
      if (error || !data) throw error || new Error('download failed');
      return URL.createObjectURL(data);
    });
    p.catch(() => state.photoUrls.delete(key)); // allow a retry later
    state.photoUrls.set(key, p);
  }
  return state.photoUrls.get(key);
}
const photoUrl = (path) => blobUrl('photos', path);

// ---------------------------------------------------------------------
//  Opening and closing chats
// ---------------------------------------------------------------------

async function openChat(convId) {
  if (state.activeId && state.activeId !== convId) {
    cancelEdit();
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

  joinTyping(convId);
  applyTheme();
  applyWallpaper();
  renderChatHeader();
  renderChatList();

  const input = $('composer-input');
  input.value = state.drafts.get(convId) || '';
  autosize();

  $('message-list').replaceChildren(h('p', { class: 'chat-start' }, 'Loading…'));
  $('btn-older').hidden = true;
  if (state.messages.has(convId)) await fetchNewer(convId);
  else await fetchLatest(convId);
  await loadScheduled(convId);
  if (state.activeId !== convId) return;

  renderMessages(true);
  markRead(convId);
  if (!isTouch) input.focus();
}

function closeChat({ quiet = false } = {}) {
  cancelEdit();
  if (state.activeId) {
    stopTyping();
    saveDraft();
  }
  clearReply();
  leaveTyping();
  state.activeId = null;
  applyWallpaper();
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
  if (state.editing) return saveEdit(body);
  stopTyping();

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
  if (temp.sticker_path) row.sticker_path = temp.sticker_path;
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
  if (m.uploads) deliverAlbum(m);
  else if (m.upload) deliverPhoto(m);
  else if (m.fileBlob) deliverFile(m);
  else deliver(m);
}

// ---------------------------------------------------------------------
//  Photos
// ---------------------------------------------------------------------

// Sends what was picked on the edit screen: one album (2+ photos, once
// media-extras.sql is set up) or photos one at a time. Untouched photos keep
// their full original quality; edited ones are saved as a high-quality JPEG
// (doodles as PNG). Either way, hidden details are removed first.
async function sendItems(convId, items, caption = '') {
  if (!convId || !items.length) return;
  if (state.media && items.length > 1) {
    const temp = newTemp(convId, { body: caption, preparing: true, album_local: items.map(() => null) });
    clearReply();
    renderMessages(true);
    const uploads = [];
    const locals = [];
    for (const [i, item] of items.entries()) {
      try {
        const upload = await preparePhoto(await finishedFile(item));
        uploads.push(upload);
        locals.push(URL.createObjectURL(upload.thumb));
      } catch (error) {
        toast(error?.message || "Couldn't read one of the photos.");
      } finally {
        releaseItem(item);
      }
      temp.album_local = [...locals, ...items.slice(i + 1).map(() => null)];
      if (state.activeId === convId) renderMessages();
    }
    temp.preparing = false;
    if (uploads.length > 1) {
      temp.uploads = uploads;
      temp.album_local = locals;
      if (state.activeId === convId) renderMessages(true);
      await deliverAlbum(temp);
      return;
    }
    // Only one photo could be read: send it on its own.
    delete temp.album_local;
    if (!uploads.length) {
      dropTemp(temp);
      return;
    }
    Object.assign(temp, { upload: uploads[0], photo_local: locals[0], photo_width: uploads[0].width, photo_height: uploads[0].height });
    if (state.activeId === convId) renderMessages(true);
    await deliverPhoto(temp);
    return;
  }

  const temps = items.map((item, i) => ({ item, temp: newTemp(convId, { preparing: true, body: i === 0 ? caption : '' }) }));
  clearReply();
  renderMessages(true);
  for (const { item, temp } of temps) {
    try {
      temp.upload = await preparePhoto(await finishedFile(item));
      temp.preparing = false;
      temp.photo_local = URL.createObjectURL(temp.upload.thumb);
      temp.photo_width = temp.upload.width;
      temp.photo_height = temp.upload.height;
    } catch (error) {
      dropTemp(temp);
      toast(error?.message || "Couldn't read that photo.");
      continue;
    } finally {
      releaseItem(item);
    }
    if (state.activeId === convId) renderMessages(true);
    await deliverPhoto(temp);
  }
}

function dropTemp(temp) {
  const list = state.messages.get(temp.conversation_id) || [];
  const i = list.indexOf(temp);
  if (i !== -1) list.splice(i, 1);
  if (state.activeId === temp.conversation_id) renderMessages();
}

// The picture to send: the original if untouched, otherwise the edited one.
async function finishedFile(item) {
  if (!isEdited(item)) return item.file;
  const type = item.blank ? 'image/png' : 'image/jpeg';
  const blob = await exportItem(item, { type });
  return new File([blob], item.blank ? 'doodle.png' : 'photo.jpg', { type });
}

function releaseItem(item) {
  releasePreview(item);
  if (item.url) URL.revokeObjectURL(item.url);
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  item.url = null;
  item.thumbUrl = null;
}

async function deliverAlbum(temp) {
  const convId = temp.conversation_id;
  const bucket = supabase.storage.from('photos');
  const uploaded = [];
  let data = null;
  let error = null;
  const album = [];
  try {
    for (const u of temp.uploads) {
      const id = crypto.randomUUID();
      const path = `${convId}/${id}.${u.ext}`;
      const thumb = `${convId}/${id}-thumb.jpg`;
      const a = await bucket.upload(path, u.original, { contentType: u.mime, upsert: false, cacheControl: '31536000' });
      if (a.error) throw a.error;
      uploaded.push(path);
      const b = await bucket.upload(thumb, u.thumb, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
      if (b.error) throw b.error;
      uploaded.push(thumb);
      album.push({ path, thumb, width: u.width, height: u.height });
    }
    const row = {
      conversation_id: convId,
      body: temp.body || '',
      photo_path: album[0].path,
      photo_thumb_path: album[0].thumb,
      photo_width: album[0].width,
      photo_height: album[0].height,
      album,
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
    album.forEach((a, i) => state.photoUrls.set(`photos:${a.thumb}`, Promise.resolve(temp.album_local[i])));
  }
  settle(temp, data, error);
  if (error) toast(error?.statusCode === '413' || /exceeded|too large|size/i.test(error?.message || '')
    ? 'One of those photos is too big for the free storage plan.'
    : "Photos didn't send. Tap them to try again.");
}

function albumEl(m, bubble, local) {
  const thumbs = m.album_local || m.album.map((a) => a.thumb);
  const n = thumbs.length;
  const shown = Math.min(n, 4);
  const grid = h('div', { class: `msg-album n${shown}` });
  for (let i = 0; i < shown; i++) {
    const img = h('img', { alt: '', decoding: 'async' });
    if (m.album_local) {
      if (thumbs[i]) img.src = thumbs[i];
    } else {
      photoUrl(thumbs[i]).then((url) => { img.src = url; }, () => { img.alt = "Photo couldn't load"; });
    }
    grid.append(h('button', {
      type: 'button',
      class: 'album-tile',
      'aria-label': `Open photo ${i + 1} of ${n}`,
      onclick: (e) => { if (!local) { e.stopPropagation(); tapped(m, bubble, () => openViewer(m, i)); } },
    }, img, i === 3 && n > 4 ? h('span', { class: 'album-more', 'aria-hidden': 'true' }, `+${n - 3}`) : null));
  }
  return grid;
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
      body: temp.body || '',
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
    state.photoUrls.set(`photos:${thumbPath}`, Promise.resolve(temp.photo_local));
  }
  settle(temp, data, error);
  if (error) toast(error?.statusCode === '413' || /exceeded|too large|size/i.test(error?.message || '')
    ? 'That photo is too big for the free storage plan.'
    : "Photo didn't send. Tap it to try again.");
}

// Full-size viewer. For an album, swipe or use the arrows to see the rest.
let viewer = { m: null, list: [], index: 0, token: 0 };

function openViewer(m, index = 0) {
  const list = Array.isArray(m.album) && m.album.length ? m.album : [{ path: m.photo_path, thumb: m.photo_thumb_path }];
  viewer = { m, list, index: Math.min(Math.max(0, index), list.length - 1), token: viewer.token };
  const dlg = $('dlg-photo');
  if (!dlg.open) dlg.showModal();
  showViewerPhoto();
}

async function showViewerPhoto() {
  const { m, list, index } = viewer;
  const token = ++viewer.token;
  const item = list[index];
  const img = $('viewer-img');
  const save = $('viewer-save');
  const status = $('viewer-status');
  const many = list.length > 1;
  $('viewer-count').hidden = !many;
  $('viewer-count').textContent = `${index + 1} of ${list.length}`;
  $('viewer-prev').hidden = !many || index === 0;
  $('viewer-next').hidden = !many || index === list.length - 1;
  img.removeAttribute('src');
  img.alt = many ? `Photo ${index + 1} of ${list.length}` : 'Photo';
  save.hidden = true;
  status.hidden = false;
  status.textContent = 'Loading full photo…';
  try {
    const quick = await photoUrl(item.thumb); // quick preview first
    if (token === viewer.token) img.src = quick;
  } catch { /* the full photo below may still work */ }
  try {
    const url = await photoUrl(item.path);
    if (token !== viewer.token || !$('dlg-photo').open) return;
    img.src = url;
    save.href = url;
    save.download = `boom-boom-${new Date(m.created_at).toISOString().slice(0, 10)}-${m.id}${many ? `-${index + 1}` : ''}.${item.path.split('.').pop()}`;
    save.hidden = false;
    status.hidden = true;
  } catch {
    if (token === viewer.token) status.textContent = "Couldn't load the full photo. Check your connection.";
  }
}

function stepViewer(step) {
  const next = viewer.index + step;
  if (next < 0 || next >= viewer.list.length) return;
  viewer.index = next;
  showViewerPhoto();
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
  $('act-photo').textContent = Array.isArray(m.album) ? 'View photos' : 'View full photo';
  $('act-download').hidden = !m.file_path;
  $('act-save-sticker').hidden = !state.media || !m.sticker_path || state.stickers.some((s) => s.path === m.sticker_path);
  $('act-edit').hidden = !canEdit(m);
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
  const sentFile = m.file_path;
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
  if (sentFile) supabase.storage.from('files').remove([sentFile]).catch(() => {});
  Object.assign(m, {
    body: '', photo_path: null, photo_thumb_path: null, album: null, file_path: null, file_name: null,
    file_size: null, file_type: null, sticker_path: null, deleted_at: new Date().toISOString(),
  });
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
    .filter((p) => !q || shownName(p.id).toLowerCase().includes(q) || p.display_name.toLowerCase().includes(q) || p.username.includes(q))
    .sort((a, b) => shownName(a.id).localeCompare(shownName(b.id)));

  const list = $('people-list');
  list.replaceChildren();
  for (const p of matches) {
    list.append(h('li', {},
      h('button', { type: 'button', class: 'person', onclick: () => startChatWith(p.id) },
        avatarEl(p, 'sm'),
        h('span', {},
          h('span', { class: 'person-name' }, shownName(p.id)),
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
    let cleared = null;
    if (state.avatars) {
      const { data: mine } = await supabase.from('conversation_members').select('cleared_at')
        .eq('conversation_id', convId).eq('user_id', state.user.id).maybeSingle();
      cleared = mine?.cleared_at || null;
    }
    state.chats.unshift({
      conversation_id: convId, is_group: false, title: null, other_user_id: userId,
      last_message_at: null, last_message_body: null, last_message_sender: null,
      unread_count: 0, cleared_at: cleared, local: true,
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
  renderAvatarSettings();
  $('share-typing').checked = state.me?.share_typing !== false;
  renderInstall();
  renderNotifySettings();
  $('dlg-settings').showModal();
}

// ---------------------------------------------------------------------
//  Profile picture
// ---------------------------------------------------------------------

function renderAvatarSettings() {
  $('avatar-preview').replaceChildren(avatarEl(state.me, 'lg'));
  $('btn-avatar-change').textContent = state.me?.avatar_path ? 'Change photo' : 'Add a photo';
  $('btn-avatar-remove').hidden = !state.me?.avatar_path;
  $('avatar-status').hidden = true;
}

function avatarStatus(text, isError = false) {
  const el = $('avatar-status');
  el.textContent = text;
  el.className = isError ? 'form-error' : 'muted';
  el.hidden = !text;
}

async function saveAvatarPath(path) {
  const { data, error } = await supabase.from('profiles')
    .update({ avatar_path: path }).eq('id', state.user.id)
    .select('id, username, display_name, avatar_path').single();
  if (error) throw error;
  state.me = { ...state.me, ...data };
  state.profiles.set(state.me.id, state.me);
}

async function setAvatar(file) {
  const button = $('btn-avatar-change');
  setBusy(button, true);
  avatarStatus('Saving your photo…');
  const bucket = supabase.storage.from('avatars');
  const oldPath = state.me.avatar_path;
  const path = `${state.user.id}/${crypto.randomUUID()}.jpg`;
  let uploaded = false;
  try {
    const blob = await makeAvatar(file); // square, small, hidden details removed
    const up = await bucket.upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
    if (up.error) throw up.error;
    uploaded = true;
    state.photoUrls.set(`avatars:${path}`, Promise.resolve(URL.createObjectURL(blob)));
    await saveAvatarPath(path);
    if (oldPath) bucket.remove([oldPath]).catch(() => {});
    avatarStatus('');
  } catch (error) {
    if (uploaded) bucket.remove([path]).catch(() => {});
    avatarStatus(error?.code === 'unsupported' ? error.message : "Couldn't save your photo. Check your connection and try again.", true);
  } finally {
    setBusy(button, false);
  }
  renderAvatarSettings();
  renderChatList();
}

async function removeAvatar() {
  const oldPath = state.me.avatar_path;
  if (!oldPath) return;
  try {
    await saveAvatarPath(null);
    supabase.storage.from('avatars').remove([oldPath]).catch(() => {});
  } catch {
    avatarStatus("Couldn't remove your photo. Check your connection.", true);
    return;
  }
  renderAvatarSettings();
  renderChatList();
}

// ---------------------------------------------------------------------
//  Delete chat (for you only)
// ---------------------------------------------------------------------

let deleteArmed = null;

function openChatOptions() {
  const chat = activeChat();
  if (!chat) return;
  $('chat-delete-note').textContent = `Deletes this chat and its messages from your Boom Boom only. ${chatName(chat)} keeps their copy. To remove a message for everyone, unsend it instead.`;
  renderSwatches();
  const other = state.profiles.get(chat.other_user_id);
  $('nickname-input').value = state.nicknames.get(chat.other_user_id) || '';
  $('nickname-input').placeholder = other?.display_name || '';
  $('nickname-status').hidden = true;
  renderWallTiles();
  resetDeleteChat();
  $('dlg-chat').showModal();
}

function resetDeleteChat() {
  clearTimeout(deleteArmed);
  deleteArmed = null;
  const b = $('act-delete-chat');
  b.textContent = 'Delete chat';
  b.classList.remove('armed');
}

async function deleteChat() {
  const convId = state.activeId;
  if (!convId) return;
  const { error } = await supabase.rpc('delete_chat', { conv: convId });
  if (error) {
    toast(isNetworkError(error) ? "Couldn't delete the chat. Check your connection." : error.message);
    return;
  }
  $('dlg-chat').close();
  state.chats = state.chats.filter((c) => c.conversation_id !== convId);
  state.messages.delete(convId);
  state.drafts.delete(convId);
  $('composer-input').value = '';
  if (history.state?.chat) history.back();
  else closeChat();
  renderChatList();
  updateTitle();
  toast('Chat deleted.');
}

function wireProfilePictureAndChatOptions() {
  $('btn-avatar-change').addEventListener('click', () => $('avatar-input').click());
  $('avatar-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) setAvatar(file);
  });
  $('btn-avatar-remove').addEventListener('click', removeAvatar);

  $('btn-chat-menu').addEventListener('click', openChatOptions);
  $('act-delete-chat').addEventListener('click', () => {
    const button = $('act-delete-chat');
    if (!deleteArmed) {
      button.textContent = 'Tap again to delete this chat';
      button.classList.add('armed');
      deleteArmed = setTimeout(resetDeleteChat, 4000);
      return;
    }
    resetDeleteChat();
    deleteChat();
  });
  $('dlg-chat').addEventListener('close', resetDeleteChat);
}

// ---------------------------------------------------------------------
//  Auto-update
//  When a new version is on GitHub, Boom Boom refreshes itself the next
//  time you come back to it (or offers a button if you're mid-message).
// ---------------------------------------------------------------------

const APP_FILES = ['./', './app.js', './photo.js', './editor.js', './config.js', './style.css', './sw.js', './manifest.webmanifest'];
const UPDATE_KEY = 'boom-updated-to';
const DRAFTS_KEY = 'boom-drafts';
let runningVersion = null;
let checkingUpdate = false;

async function appFingerprint(cacheMode) {
  const parts = await Promise.all(APP_FILES.map(async (file) => {
    const res = await fetch(file, { cache: cacheMode });
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { all.set(p, offset); offset += p.length; }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function initAutoUpdate() {
  try {
    runningVersion = await appFingerprint('force-cache'); // what's running now
  } catch {
    return; // offline or unusual setup: just don't auto-update
  }
  setInterval(() => {
    if (document.visibilityState === 'visible') checkForUpdate(false);
  }, 15 * 60 * 1000);
}

function safeToReload() {
  if (document.querySelector('dialog[open]')) return false;
  if ($('composer-input').value.trim()) return false;
  for (const list of state.messages.values()) {
    if (list.some((m) => m.pending)) return false;
  }
  return true;
}

async function checkForUpdate(justReturned) {
  if (!runningVersion || checkingUpdate) return;
  checkingUpdate = true;
  try {
    const latest = await appFingerprint('no-cache'); // asks GitHub if anything changed
    if (latest === runningVersion) return;
    let alreadyTried = false;
    try { alreadyTried = sessionStorage.getItem(UPDATE_KEY) === latest; } catch { /* private mode */ }
    if (justReturned && safeToReload() && !alreadyTried) {
      await applyUpdate(latest);
    } else {
      $('update-banner').hidden = false;
    }
  } catch {
    /* offline: try again later */
  } finally {
    checkingUpdate = false;
  }
}

async function applyUpdate(latest) {
  // Refresh the browser's stored copies of the app files, then reload.
  await Promise.all(APP_FILES.map((file) => fetch(file, { cache: 'reload' }).catch(() => {})));
  cancelEdit();
  try {
    if (latest) sessionStorage.setItem(UPDATE_KEY, latest);
    saveDraft();
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify([...state.drafts]));
  } catch { /* private mode: drafts can't be kept */ }
  const url = new URL(location.href);
  url.search = '';
  if (state.activeId) url.searchParams.set('chat', state.activeId); // come back to the same chat
  location.replace(url.href);
}

function restoreDraftsAfterUpdate() {
  try {
    const saved = sessionStorage.getItem(DRAFTS_KEY);
    if (!saved) return;
    sessionStorage.removeItem(DRAFTS_KEY);
    for (const [convId, text] of JSON.parse(saved)) state.drafts.set(convId, text);
  } catch { /* nothing to restore */ }
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
  forgetNicknamesOnThisDevice();
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
  input.addEventListener('input', () => {
    autosize();
    if (input.value.trim()) noteTyping();
    else stopTyping();
  });
  input.addEventListener('blur', stopTyping);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.editing) { e.preventDefault(); cancelEdit(); }
  });
  input.addEventListener('keydown', (e) => {
    // Enter sends on computers; on phones Enter makes a new line and the button sends.
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.isComposing) {
      e.preventDefault();
      sendCurrent();
    }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (Date.now() < suppressSendUntil) return; // that tap was a hold for "send later"
    sendCurrent();
    if (isTouch) input.focus(); // keep the keyboard up
  });
  // Hold the send button (or right-click it) to send later.
  const send = $('btn-send');
  let sendHold = null;
  send.addEventListener('pointerdown', () => {
    if (!state.later || send.disabled || state.editing) return;
    sendHold = setTimeout(() => {
      sendHold = null;
      suppressSendUntil = Date.now() + 800;
      navigator.vibrate?.(10);
      openSendLater();
    }, 500);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
    send.addEventListener(type, () => { clearTimeout(sendHold); sendHold = null; });
  }
  send.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!state.later || send.disabled || state.editing) return;
    if (isTouch) suppressSendUntil = Date.now() + 800; // a long-press may end in a tap
    openSendLater();
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
    state.me = { ...state.me, ...data };
    state.profiles.set(data.id, state.me);
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

  // ⊕: photos, doodles, stickers and files
  $('btn-attach').addEventListener('click', () => $('dlg-attach').showModal());
  $('photo-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = ''; // so picking the same photo again still works
    openCompose('photos', files);
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
  $('act-download').addEventListener('click', () => {
    $('dlg-msg').close();
    if (menuMessage) downloadFile(menuMessage);
  });
  $('act-save-sticker').addEventListener('click', () => {
    $('dlg-msg').close();
    if (menuMessage) saveFriendSticker(menuMessage);
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
    if (e.target === $('dlg-photo') || e.target.classList.contains('viewer-stage') || e.target.closest('[data-close]')) $('dlg-photo').close();
  });

  // Close sheets with the × button or by tapping outside them
  for (const dlg of document.querySelectorAll('dialog.sheet')) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  }

  // Coming back to the tab: catch up, clear what you've now seen, and pick
  // up a new version of Boom Boom if there is one.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.started) resync();
    checkForUpdate(true);
  });
  $('update-banner').addEventListener('click', () => applyUpdate(null));
  window.addEventListener('online', () => { if (state.started) resync(); });
}

// ---------------------------------------------------------------------
//  "typing…" (private live channel per chat; only who's typing is sent)
// ---------------------------------------------------------------------

let typingChannel = null;
let typingConv = null;
let typingUntil = 0;
let typingHide = null;
let lastTypingSent = 0;

function joinTyping(convId) {
  if (typingConv === convId && typingChannel) return;
  leaveTyping();
  if (!state.extras) return;
  typingConv = convId;
  typingChannel = supabase
    .channel(`typing:${convId}`, { config: { private: true, broadcast: { self: false } } })
    .on('broadcast', { event: 'typing' }, ({ payload }) => onTyping(convId, payload))
    .subscribe();
}

function leaveTyping() {
  if (typingChannel) supabase.removeChannel(typingChannel);
  typingChannel = null;
  typingConv = null;
  typingUntil = 0;
  lastTypingSent = 0;
  clearTimeout(typingHide);
}

function sendTypingSignal(typing) {
  try {
    Promise.resolve(typingChannel.send({ type: 'broadcast', event: 'typing', payload: { user_id: state.user.id, typing } })).catch(() => {});
  } catch { /* not connected yet */ }
}

function noteTyping() {
  if (!typingChannel || state.editing || state.me?.share_typing === false) return;
  const now = Date.now();
  if (now - lastTypingSent < 2500) return; // at most every 2.5 seconds
  lastTypingSent = now;
  sendTypingSignal(true);
}

function stopTyping() {
  if (!typingChannel || !lastTypingSent) return;
  lastTypingSent = 0;
  sendTypingSignal(false);
}

function onTyping(convId, payload) {
  if (!payload || payload.user_id === state.user?.id || convId !== state.activeId) return;
  clearTimeout(typingHide);
  typingUntil = payload.typing ? Date.now() + 6000 : 0;
  renderChatHeader();
  if (payload.typing) {
    typingHide = setTimeout(() => { typingUntil = 0; renderChatHeader(); }, 6000);
  }
}

// ---------------------------------------------------------------------
//  Edit (your own text messages, within 15 minutes)
// ---------------------------------------------------------------------

const EDIT_WINDOW_MS = 15 * 60 * 1000;

function canEdit(m) {
  return state.extras && m.sender_id === state.user.id && !m.deleted_at && !m.photo_path && !m.file_path && !m.sticker_path
    && typeof m.id === 'number' && Date.now() - time(m.created_at) < EDIT_WINDOW_MS;
}

function startEdit(m) {
  clearReply();
  const input = $('composer-input');
  if (!state.editing) state.editDraft = input.value;
  state.editing = m;
  input.value = m.body;
  autosize();
  $('edit-bar').hidden = false;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function cancelEdit() {
  if (!state.editing) return;
  state.editing = null;
  $('edit-bar').hidden = true;
  const input = $('composer-input');
  input.value = state.editDraft || '';
  state.editDraft = '';
  autosize();
}

async function saveEdit(body) {
  const m = state.editing;
  if (body === (m.body || '').trim()) { cancelEdit(); return; }
  const { error } = await supabase.rpc('edit_message', { p_message_id: m.id, p_body: body });
  if (error) {
    toast(/15 minutes/.test(error.message) ? 'Messages can only be edited for 15 minutes after sending.'
      : isNetworkError(error) ? "Couldn't save the edit. Check your connection." : error.message);
    return;
  }
  Object.assign(m, { body, edited_at: new Date().toISOString() });
  cancelEdit();
  renderMessages();
  loadChats();
}

// ---------------------------------------------------------------------
//  Search
// ---------------------------------------------------------------------

let searchTimer = null;
let searchSeq = 0;

function openSearch() {
  $('search-input').value = '';
  $('search-results').replaceChildren();
  $('search-empty').hidden = true;
  $('dlg-search').showModal();
  if (!isTouch) $('search-input').focus();
}

async function runSearch(raw) {
  const term = raw.trim();
  const seq = ++searchSeq;
  const results = $('search-results');
  const empty = $('search-empty');
  if (term.length < 2) {
    results.replaceChildren();
    empty.hidden = true;
    return;
  }
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  let query = supabase.from('messages').select(msgColumns()).ilike('body', pattern).order('id', { ascending: false }).limit(60);
  if (state.features) query = query.is('deleted_at', null);
  const { data, error } = await query;
  if (seq !== searchSeq) return; // a newer search is on its way
  if (error) {
    results.replaceChildren();
    empty.textContent = "Search isn't available right now. Check your connection.";
    empty.hidden = false;
    return;
  }
  // Only chats in your list, and nothing from before you deleted a chat.
  const hits = data.filter((m) => {
    const chat = state.chats.find((c) => c.conversation_id === m.conversation_id);
    return chat && time(m.created_at) > time(chat.cleared_at || 0);
  }).slice(0, 30);
  results.replaceChildren(...hits.map((m) => searchHit(m, term)));
  empty.textContent = `No messages match "${term}".`;
  empty.hidden = hits.length > 0;
}

function highlighted(text, term) {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const needle = term.toLowerCase();
  const first = lower.indexOf(needle);
  const start = first > 40 ? first - 30 : 0;
  const out = [];
  if (start > 0) out.push('…');
  let i = start;
  while (i < flat.length) {
    const at = lower.indexOf(needle, i);
    if (at === -1) { out.push(flat.slice(i)); break; }
    if (at > i) out.push(flat.slice(i, at));
    out.push(h('mark', {}, flat.slice(at, at + needle.length)));
    i = at + needle.length;
  }
  return out;
}

function searchHit(m, term) {
  const chat = state.chats.find((c) => c.conversation_id === m.conversation_id);
  const other = state.profiles.get(chat?.other_user_id);
  return h('li', {},
    h('button', { type: 'button', class: 'search-hit', onclick: () => openSearchResult(m) },
      avatarEl(other ?? { id: m.conversation_id, display_name: chatName(chat || {}) }, 'sm'),
      h('span', { class: 'search-hit-main' },
        h('span', { class: 'search-hit-top' },
          h('strong', {}, chatName(chat || {})),
          h('time', { datetime: m.created_at }, listTime(m.created_at))),
        h('span', { class: 'search-hit-text' }, m.sender_id === state.user.id ? 'You: ' : '', ...highlighted(m.body || '', term)))));
}

async function openSearchResult(m) {
  $('dlg-search').close();
  await openChat(m.conversation_id);
  if (state.activeId !== m.conversation_id) return;
  for (let i = 0; i < 20; i++) { // load older pages until the message is on screen
    const list = state.messages.get(m.conversation_id) || [];
    if (list.some((x) => x.id === m.id) || !state.hasMore.get(m.conversation_id)) break;
    await fetchOlder(m.conversation_id);
  }
  renderMessages();
  jumpToMessage(m.id);
}

// ---------------------------------------------------------------------
//  Chat colours (shared by both people in the chat)
// ---------------------------------------------------------------------

const THEME_LABELS = {
  hibiscus: 'Hibiscus red', ocean: 'Ocean blue', jungle: 'Jungle green', sunset: 'Sunset orange',
  grape: 'Grape purple', indigo: 'Indigo', rose: 'Rose pink', teal: 'Teal',
};

function applyTheme() {
  const colour = THEMES[activeChat()?.theme];
  const el = $('conversation-inner');
  if (colour) el.style.setProperty('--mine', colour);
  else el.style.removeProperty('--mine');
}

function renderSwatches() {
  const current = activeChat()?.theme || 'hibiscus';
  $('swatches').replaceChildren(...Object.entries(THEMES).map(([name, colour]) => h('button', {
    type: 'button',
    class: `swatch${name === current ? ' chosen' : ''}`,
    style: `background:${colour}`,
    'aria-label': THEME_LABELS[name],
    'aria-pressed': name === current ? 'true' : 'false',
    title: THEME_LABELS[name],
    onclick: () => setTheme(name),
  })));
}

async function setTheme(name) {
  const chat = activeChat();
  if (!chat) return;
  const before = chat.theme;
  chat.theme = name;
  applyTheme();
  renderSwatches();
  const { error } = await supabase.rpc('set_chat_theme', { conv: chat.conversation_id, p_theme: name });
  if (error) {
    chat.theme = before;
    applyTheme();
    renderSwatches();
    toast("Couldn't change the colour. Check your connection.");
  }
}

function onConversationUpdate(c) {
  const chat = state.chats.find((x) => x.conversation_id === c.id);
  if (!chat || (chat.theme || null) === (c.theme || null)) return;
  chat.theme = c.theme;
  if (c.id === state.activeId) {
    applyTheme();
    if ($('dlg-chat').open) renderSwatches();
  }
}

function wireExtras() {
  $('btn-search').addEventListener('click', openSearch);
  $('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 300);
  });
  $('act-edit').addEventListener('click', () => {
    $('dlg-msg').close();
    if (menuMessage) startEdit(menuMessage);
  });
  $('btn-edit-cancel').addEventListener('click', cancelEdit);
  $('share-typing').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (!on) stopTyping();
    const { error } = await supabase.from('profiles').update({ share_typing: on }).eq('id', state.user.id);
    if (error) {
      e.target.checked = !on;
      toast("Couldn't save that setting. Check your connection.");
      return;
    }
    state.me = { ...state.me, share_typing: on };
    state.profiles.set(state.me.id, state.me);
  });
}

// ---------------------------------------------------------------------
//  Double-tap for ❤️
// ---------------------------------------------------------------------

let lastTap = null;

// A single tap does `single` (e.g. open the photo) unless a second tap on the
// same message follows quickly, which hearts it instead.
function tapped(m, bubble, single) {
  if (!state.features || typeof m.id !== 'number') { single?.(); return; }
  const now = Date.now();
  if (lastTap && lastTap.id === m.id && now - lastTap.at < 320) {
    clearTimeout(lastTap.timer);
    lastTap = null;
    heart(m);
    return;
  }
  lastTap = { id: m.id, at: now, timer: single ? setTimeout(single, 300) : null };
}

function heart(m) {
  if (m.deleted_at) return;
  // Double-tap only ever adds a heart; it never takes one away.
  if (state.reactions.get(m.id)?.get(state.user.id) !== '❤️') react(m, '❤️');
  navigator.vibrate?.(8);
  const bubble = $('message-list').querySelector(`.msg[data-id="${m.id}"]`);
  if (!bubble) return;
  // Drawn above the chat, so it survives the list redrawing underneath it.
  const r = bubble.getBoundingClientRect();
  const burst = h('span', {
    class: 'heart-burst', 'aria-hidden': 'true', style: `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px`,
  }, '❤️');
  document.body.append(burst);
  setTimeout(() => burst.remove(), 900);
}

// ---------------------------------------------------------------------
//  Nicknames (only you see them)
// ---------------------------------------------------------------------

async function loadNicknames() {
  if (!state.later) return;
  const { data, error } = await supabase.from('nicknames').select('target_id, nickname');
  if (error) return; // real names still work
  state.nicknames = new Map(data.map((n) => [n.target_id, n.nickname]));
}

async function saveNickname(e) {
  e.preventDefault();
  const chat = activeChat();
  const target = chat?.other_user_id;
  if (!target) return;
  const input = $('nickname-input');
  const value = input.value.trim().slice(0, 40);
  const status = $('nickname-status');
  const button = $('btn-nickname-save');
  button.disabled = true;
  const { error } = await supabase.rpc('set_nickname', { p_target: target, p_nickname: value || null });
  button.disabled = false;
  status.hidden = false;
  if (error) {
    status.textContent = isNetworkError(error) ? "Couldn't save the nickname. Check your connection." : error.message;
    return;
  }
  if (value) state.nicknames.set(target, value);
  else state.nicknames.delete(target);
  input.value = value;
  status.textContent = value ? `Saved. Only you see "${value}".` : 'Nickname removed.';
  $('chat-delete-note').textContent = `Deletes this chat and its messages from your Boom Boom only. ${chatName(chat)} keeps their copy. To remove a message for everyone, unsend it instead.`;
  renderChatHeader();
  renderChatList();
  renderMessages();
  saveNicknamesForNotifications();
}

// Notifications are shown by the service worker, which can't see your
// nicknames. So this device keeps a tiny list of them for it, which never
// leaves the device.
const NICKNAME_CACHE = 'boom-local';
const nicknameFile = () => new URL('__nicknames.json', location.href).href;
let savedNicknames = null;

async function saveNicknamesForNotifications() {
  if (!('caches' in window)) return;
  const map = {};
  for (const c of state.chats) {
    const nick = c.other_user_id && state.nicknames.get(c.other_user_id);
    if (nick) map[c.conversation_id] = nick;
  }
  const json = JSON.stringify(map);
  if (json === savedNicknames) return;
  try {
    const cache = await caches.open(NICKNAME_CACHE);
    await cache.put(nicknameFile(), new Response(json, { headers: { 'content-type': 'application/json' } }));
    savedNicknames = json;
  } catch { /* notifications just use real names */ }
}

function forgetNicknamesOnThisDevice() {
  savedNicknames = null;
  if ('caches' in window) caches.delete(NICKNAME_CACHE).catch(() => {});
}

// ---------------------------------------------------------------------
//  Send later (hold the send button)
// ---------------------------------------------------------------------

let suppressSendUntil = 0;
let scheduling = false;
let menuScheduled = null;
let scheduledDeleteArmed = null;
const DAY_MS = 24 * 60 * 60 * 1000;

// "today at 8:00 pm", "tomorrow at 8:00 am", "Sat 24 Oct at 9:30 pm"
function whenLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const tomorrow = new Date(); tomorrow.setDate(now.getDate() + 1);
  const at = clockTime(d);
  if (d.toDateString() === now.toDateString()) return `today at ${at}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${at}`;
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return `${d.toLocaleDateString([], opts)} at ${at}`;
}

// The format a datetime-local box wants, in your own time zone.
function localInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function laterPicks() {
  const now = new Date();
  const inAnHour = new Date(now.getTime() + 60 * 60 * 1000);
  inAnHour.setSeconds(0, 0);
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const morning = new Date(now);
  morning.setHours(8, 0, 0, 0);
  if (morning - now < 30 * 60 * 1000) morning.setDate(morning.getDate() + 1);
  return [
    ['In 1 hour', inAnHour],
    ['Midnight', midnight],
    [morning.getDate() === now.getDate() ? 'This morning' : 'Tomorrow morning', morning],
  ];
}

function openSendLater() {
  const dlg = $('dlg-later');
  const body = $('composer-input').value.trim();
  if (!state.later || !state.activeId || !body || state.editing || dlg.open) return;
  const preview = $('later-preview');
  preview.replaceChildren();
  appendStyled(preview, body);
  $('later-picks').replaceChildren(...laterPicks().map(([label, when]) => h('button', {
    type: 'button',
    class: 'later-pick',
    onclick: () => scheduleCurrent(when),
  }, h('strong', {}, label), h('span', {}, whenLabel(when)))));
  const box = $('later-when');
  const nextHour = new Date(Date.now() + 2 * 60 * 60 * 1000);
  nextHour.setMinutes(0, 0, 0);
  box.min = localInputValue(new Date(Date.now() + 60 * 1000));
  box.max = localInputValue(new Date(Date.now() + 365 * DAY_MS));
  box.value = localInputValue(nextHour);
  $('later-error').hidden = true;
  dlg.showModal();
}

async function scheduleCurrent(when) {
  const convId = state.activeId;
  const input = $('composer-input');
  const body = input.value.trim();
  const err = $('later-error');
  const fail = (text) => { err.textContent = text; err.hidden = false; };
  err.hidden = true;
  if (!convId || !body || scheduling) return;
  if (!(when instanceof Date) || Number.isNaN(when.getTime())) return fail('Pick a date and time.');
  if (when.getTime() < Date.now() + 30 * 1000) return fail('Pick a time at least a minute from now.');
  if (when.getTime() > Date.now() + 365 * DAY_MS) return fail('Messages can be scheduled up to a year ahead.');

  scheduling = true;
  const replyTo = typeof state.replyTo?.id === 'number' ? state.replyTo.id : null;
  const { data: id, error } = await supabase.rpc('schedule_message', {
    conv: convId, p_body: body, p_send_at: when.toISOString(), p_reply_to: replyTo,
  });
  scheduling = false;
  if (error) return fail(isNetworkError(error) ? "Couldn't schedule it. Check your connection." : error.message);

  $('dlg-later').close();
  state.drafts.delete(convId);
  if (state.activeId === convId) {
    stopTyping();
    input.value = '';
    autosize();
    clearReply();
  }
  onScheduledChange({ id, conversation_id: convId, sender_id: state.user.id, body, reply_to: replyTo, send_at: when.toISOString(), status: 'waiting' });
  if (state.activeId === convId) renderMessages(true);
  toast(`Scheduled for ${whenLabel(when)}.`);
}

async function loadScheduled(convId) {
  if (!state.later) return;
  const { data, error } = await supabase
    .from('scheduled_messages')
    .select('id, conversation_id, sender_id, body, reply_to, send_at, status')
    .eq('conversation_id', convId)
    .eq('status', 'waiting')
    .order('send_at');
  if (!error) state.scheduled.set(convId, data);
}

// A scheduled message was made, sent or cancelled (on any of your devices).
function onScheduledChange(row) {
  if (!state.started || !row?.conversation_id) return;
  if (row.sender_id && row.sender_id !== state.user.id) return;
  const list = (state.scheduled.get(row.conversation_id) || []).filter((x) => x.id !== row.id);
  if (row.status === 'waiting') {
    list.push(row);
    list.sort((a, b) => time(a.send_at) - time(b.send_at));
  }
  state.scheduled.set(row.conversation_id, list);
  if (menuScheduled?.id === row.id && row.status !== 'waiting') $('dlg-scheduled').close();
  if (row.conversation_id === state.activeId) renderMessages();
}

function scheduledEl(sm) {
  const bubble = h('div', {
    class: 'msg mine tail scheduled', role: 'button', tabindex: '0', 'data-scheduled': sm.id, title: 'Scheduled message',
  });
  if (sm.reply_to) {
    const original = findMessage(sm.conversation_id, sm.reply_to);
    if (original) {
      bubble.append(h('span', { class: 'msg-quote' }, h('strong', {}, personName(original.sender_id)), h('span', {}, snippet(original))));
    }
  }
  const body = h('span', { class: 'msg-body' });
  appendLinkified(body, sm.body);
  bubble.append(body, h('span', { class: 'msg-meta' }, `🕓 Sends ${whenLabel(sm.send_at)}`));
  bubble.addEventListener('click', (e) => { if (!e.target.closest('a')) openScheduledMenu(sm); });
  bubble.addEventListener('keydown', (e) => {
    if (e.target === bubble && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openScheduledMenu(sm); }
  });
  return h('div', { class: 'msg-wrap mine' }, bubble);
}

function openScheduledMenu(sm) {
  const dlg = $('dlg-scheduled');
  if (dlg.open) return;
  menuScheduled = sm;
  $('scheduled-preview').textContent = `Sends ${whenLabel(sm.send_at)}: ${plainText(sm.body).replace(/\s+/g, ' ')}`;
  resetScheduledDelete();
  dlg.showModal();
}

function resetScheduledDelete() {
  clearTimeout(scheduledDeleteArmed);
  scheduledDeleteArmed = null;
  const b = $('act-scheduled-delete');
  b.textContent = 'Delete';
  b.classList.remove('armed');
}

function scheduledGone(sm) {
  toast('That message has already been sent.');
  onScheduledChange({ ...sm, status: 'sent', body: '' });
  loadScheduled(sm.conversation_id).then(() => { if (state.activeId === sm.conversation_id) renderMessages(); });
}

async function sendScheduledNow() {
  const sm = menuScheduled;
  $('dlg-scheduled').close();
  if (!sm) return;
  const { error } = await supabase.rpc('send_scheduled_now', { p_id: sm.id });
  if (error) {
    if (isNetworkError(error)) toast("Couldn't send it. Check your connection.");
    else scheduledGone(sm);
    return;
  }
  onScheduledChange({ ...sm, status: 'sent', body: '' });
  if (state.activeId === sm.conversation_id) {
    await fetchNewer(sm.conversation_id);
    if (state.activeId === sm.conversation_id) renderMessages(true);
  }
}

// Take it back into the message box to change it.
async function editScheduled() {
  const sm = menuScheduled;
  $('dlg-scheduled').close();
  if (!sm) return;
  const { data: cancelled, error } = await supabase.rpc('cancel_scheduled', { p_id: sm.id });
  if (error) { toast("Couldn't change it. Check your connection."); return; }
  if (!cancelled) { scheduledGone(sm); return; }
  onScheduledChange({ ...sm, status: 'cancelled', body: '' });
  if (state.activeId === sm.conversation_id) {
    const input = $('composer-input');
    input.value = input.value.trim() ? `${input.value.trimEnd()}\n${sm.body}` : sm.body;
    autosize();
    const original = sm.reply_to && findMessage(sm.conversation_id, sm.reply_to);
    if (original) startReply(original);
    else input.focus();
  }
  toast('Back in the message box. Hold send to schedule it again.');
}

async function deleteScheduled() {
  const b = $('act-scheduled-delete');
  if (!scheduledDeleteArmed) {
    b.textContent = 'Tap again to delete';
    b.classList.add('armed');
    scheduledDeleteArmed = setTimeout(resetScheduledDelete, 4000);
    return;
  }
  resetScheduledDelete();
  const sm = menuScheduled;
  $('dlg-scheduled').close();
  if (!sm) return;
  const { data: cancelled, error } = await supabase.rpc('cancel_scheduled', { p_id: sm.id });
  if (error) { toast("Couldn't delete it. Check your connection."); return; }
  if (!cancelled) { scheduledGone(sm); return; }
  onScheduledChange({ ...sm, status: 'cancelled', body: '' });
  toast('Scheduled message deleted.');
}

// ---------------------------------------------------------------------
//  On this day
// ---------------------------------------------------------------------

const MEMORY_HIDDEN_KEY = 'boom-memory-hidden';
let memoryDay = null;

async function loadMemory() {
  const card = $('memory-card');
  const today = new Date();
  memoryDay = today.toDateString();
  card.hidden = true;
  if (!state.features || !state.chats.length) return;
  const uid = state.user.id;
  try {
    if (localStorage.getItem(MEMORY_HIDDEN_KEY) === `${uid} ${memoryDay}`) return;
  } catch { /* fine */ }
  const joined = state.user.created_at ? time(state.user.created_at) - DAY_MS : 0;
  const chats = new Set(state.chats.map((c) => c.conversation_id));

  for (let years = 1; years <= 5; years++) {
    const from = new Date(today.getFullYear() - years, today.getMonth(), today.getDate());
    if (from.getTime() + DAY_MS < joined) return; // before you joined Boom Boom
    if (from.getMonth() !== today.getMonth()) continue; // 29 February in a year without one
    const to = new Date(from);
    to.setDate(from.getDate() + 1);
    const { data, error } = await supabase
      .from('messages')
      .select(MSG_COLUMNS_V2)
      .gte('created_at', from.toISOString())
      .lt('created_at', to.toISOString())
      .is('deleted_at', null)
      .order('created_at')
      .limit(100);
    if (error || state.user?.id !== uid) return;
    const usable = (data || []).filter((m) => chats.has(m.conversation_id)
      && time(m.created_at) > time(clearedAt(m.conversation_id))
      && (m.photo_path || (m.body || '').trim()));
    // Photos make the best memories; otherwise the first message that day.
    const pick = usable.find((m) => m.photo_path) || usable[0];
    if (pick) { showMemory(pick, years); return; }
  }
}

function showMemory(m, years) {
  const chat = state.chats.find((c) => c.conversation_id === m.conversation_id);
  if (!chat) return;
  const date = new Date(m.created_at).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
  $('memory-label').textContent = `On this day, ${years === 1 ? 'a year' : `${years} years`} ago · ${date}`;
  $('memory-chat').textContent = chatName(chat);
  $('memory-text').textContent = `${m.sender_id === state.user.id ? 'You: ' : ''}${snippet(m)}`;
  $('memory-open').onclick = () => openSearchResult(m);
  $('memory-card').hidden = false;
}

function hideMemory() {
  $('memory-card').hidden = true;
  try { localStorage.setItem(MEMORY_HIDDEN_KEY, `${state.user.id} ${new Date().toDateString()}`); } catch { /* fine */ }
}

function wireLaterAndNicknames() {
  $('chat-nickname-section').addEventListener('submit', saveNickname);
  $('later-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('later-when').value;
    scheduleCurrent(value ? new Date(value) : null);
  });
  $('act-send-now').addEventListener('click', sendScheduledNow);
  $('act-scheduled-edit').addEventListener('click', editScheduled);
  $('act-scheduled-delete').addEventListener('click', deleteScheduled);
  $('dlg-scheduled').addEventListener('close', () => { resetScheduledDelete(); menuScheduled = null; });
  $('memory-close').addEventListener('click', hideMemory);
  // Left open overnight? Check for a new memory when you come back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.started && memoryDay !== new Date().toDateString()) loadMemory();
  });
}

// ---------------------------------------------------------------------
//  The edit screen: photos before sending, doodles, and new stickers
// ---------------------------------------------------------------------

const MAX_BATCH = 10;
const COLOUR_NAMES = ['White', 'Ink', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple'];
let editor = null;
const compose = { kind: null, items: [], index: 0, convId: null, busy: false };
let textTarget = null;
let thumbTimer = null;

async function openCompose(kind, files = []) {
  if (kind !== 'sticker' && !state.activeId) return;
  const images = [...files].filter((f) => !f.type || f.type.startsWith('image/'));
  if (kind !== 'doodle' && !images.length) {
    if (files.length) toast('That isn\'t a photo. To send other files, tap ⊕ then File.');
    return;
  }
  if (kind === 'photos' && images.length > MAX_BATCH) toast(`You can send up to ${MAX_BATCH} photos at a time, so the first ${MAX_BATCH} are ready.`);
  const items = kind === 'doodle' ? [blankItem()] : images.slice(0, kind === 'sticker' ? 1 : MAX_BATCH).map(photoItem);
  Object.assign(compose, { kind, items, index: 0, convId: state.activeId, busy: false });
  editor.aspect = kind === 'sticker' ? 1 : null;
  editor.mode = kind === 'doodle' ? 'draw' : kind === 'sticker' ? 'crop' : 'view';
  if (kind === 'sticker') items[0].shape = 'rounded';
  $('compose-title').textContent = kind === 'doodle' ? 'Doodle' : kind === 'sticker' ? 'New sticker' : '';
  $('compose-caption').value = '';
  $('compose-status').hidden = true;
  $('text-entry').hidden = true;
  $('dlg-compose').showModal();
  await showComposeItem(0);
}

async function showComposeItem(i) {
  compose.index = i;
  // Keep only the photo being edited in memory (phones run out quickly).
  compose.items.forEach((item, j) => { if (j !== i) releasePreview(item); });
  renderStrip();
  renderComposeChrome();
  try {
    await editor.show(compose.items[i]);
  } catch {
    $('compose-status').textContent = "This photo can't be edited here, but it can still be sent as it is.";
    $('compose-status').hidden = false;
  }
  renderComposeChrome();
}

function composeChanged() {
  renderComposeChrome();
  clearTimeout(thumbTimer);
  const item = compose.items[compose.index];
  thumbTimer = setTimeout(() => refreshThumb(item), 350);
}

// Update the little picture in the strip to show your edits.
async function refreshThumb(item) {
  if (!item?.preview || compose.kind !== 'photos' || !compose.items.includes(item)) return;
  const sw = item.preview.width;
  const sh = item.preview.height;
  const [W, H] = item.rot % 180 ? [sh, sw] : [sw, sh];
  const c = item.crop || { w: 1, h: 1 };
  const aspect = (c.w * W) / (c.h * H);
  const canvas = h('canvas', { width: 120, height: Math.max(1, Math.round(120 / aspect)) });
  paint(canvas.getContext('2d'), item, item.preview, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  if (!blob || !compose.items.includes(item)) return;
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  item.thumbUrl = isEdited(item) ? URL.createObjectURL(blob) : null;
  renderStrip();
}

function renderStrip() {
  const strip = $('compose-strip');
  strip.hidden = compose.kind !== 'photos';
  if (strip.hidden) return;
  const many = compose.items.length > 1;
  strip.replaceChildren(...compose.items.map((item, i) => {
    const current = i === compose.index;
    if (!item.url) item.url = URL.createObjectURL(item.file);
    return h('div', { class: `strip-item${current ? ' current' : ''}` },
      h('button', {
        type: 'button', class: 'strip-thumb', 'aria-label': `Photo ${i + 1}`, 'aria-current': current ? 'true' : null,
        onclick: () => { if (!current) showComposeItem(i); },
      }, h('img', { alt: '', src: item.thumbUrl || item.url })),
      current && many ? h('button', { type: 'button', class: 'strip-remove', 'aria-label': `Remove photo ${i + 1}`, onclick: () => removeComposeItem(i) }, '×') : null);
  }));
  if (compose.items.length < MAX_BATCH) {
    strip.append(h('button', { type: 'button', class: 'strip-add', 'aria-label': 'Add more photos', onclick: () => $('compose-add-input').click() }, '+'));
  }
  $('compose-title').textContent = many ? `${compose.items.length} photos` : 'Photo';
}

function removeComposeItem(i) {
  const [gone] = compose.items.splice(i, 1);
  if (gone) releaseItem(gone);
  showComposeItem(Math.min(i, compose.items.length - 1));
}

function addComposeItems(files) {
  const room = MAX_BATCH - compose.items.length;
  const images = [...files].filter((f) => !f.type || f.type.startsWith('image/'));
  if (images.length > room) toast(`You can send up to ${MAX_BATCH} photos at a time.`);
  const added = images.slice(0, room).map(photoItem);
  if (!added.length) return;
  compose.items.push(...added);
  showComposeItem(compose.items.length - added.length);
}

function renderComposeChrome() {
  const { kind } = compose;
  const mode = editor.mode;
  $('tool-undo').disabled = !editor.canUndo;
  $('tool-rotate').hidden = kind === 'doodle';
  $('tool-crop').hidden = kind === 'doodle';
  for (const [id, m] of [['tool-crop', 'crop'], ['tool-draw', 'draw'], ['tool-text', 'text']]) {
    $(id).setAttribute('aria-pressed', String(mode === m));
  }
  $('opt-colours').hidden = mode !== 'draw' && mode !== 'text';
  $('opt-brushes').hidden = mode !== 'draw';
  $('opt-crop').hidden = mode !== 'crop' || kind === 'sticker';
  $('opt-shape').hidden = kind !== 'sticker';
  for (const b of $('opt-colours').children) b.classList.toggle('chosen', b.dataset.colour === editor.colour);
  for (const b of $('opt-brushes').children) b.classList.toggle('chosen', Number(b.dataset.size) === editor.brush);
  for (const b of $('opt-crop').querySelectorAll('[data-aspect]')) b.classList.toggle('chosen', (b.dataset.aspect === 'square') === (editor.aspect === 1));
  const shape = compose.items[compose.index]?.shape || 'square';
  for (const b of $('opt-shape').children) b.classList.toggle('chosen', b.dataset.shape === shape);
  $('compose-caption').hidden = kind === 'sticker';
  $('compose-go').hidden = kind === 'sticker';
  $('compose-save').hidden = kind !== 'sticker';
}

function setComposeMode(mode) {
  editor.setMode(editor.mode === mode && compose.kind !== 'doodle' ? 'view' : mode);
  renderComposeChrome();
}

function openTextEntry(t, at) {
  textTarget = { t, at };
  $('text-entry-input').value = t?.text || '';
  $('text-entry').hidden = false;
  $('text-entry-input').focus();
}

function closeTextEntry(save) {
  if (save && textTarget) editor.setText(textTarget.t, $('text-entry-input').value, textTarget.at);
  textTarget = null;
  $('text-entry').hidden = true;
}

function composeStatus(text) {
  $('compose-status').textContent = text;
  $('compose-status').hidden = !text;
}

async function finishCompose(e) {
  e.preventDefault();
  if (compose.busy || !compose.items.length) return;
  if (!$('text-entry').hidden) closeTextEntry(true);
  if (compose.kind === 'sticker') {
    await saveNewSticker();
    return;
  }
  const items = compose.items;
  const caption = $('compose-caption').value.trim().slice(0, 1000);
  const convId = compose.convId;
  compose.items = []; // handed over for sending
  $('dlg-compose').close();
  sendItems(convId, items, caption);
}

function cleanUpCompose() {
  closeTextEntry(false);
  for (const item of compose.items) releaseItem(item);
  compose.items = [];
  compose.kind = null;
  editor.item = null;
}

// ---------------------------------------------------------------------
//  Files (up to 25 MB, only for the people in the chat)
// ---------------------------------------------------------------------

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MIME_RE = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,60}$/;
const downloading = new Set();

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function fileExt(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toUpperCase() : '';
}

// No slashes or invisible characters, and not too long.
function cleanFileName(name) {
  const cleaned = String(name || '').replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  if (!cleaned) return 'file';
  if (cleaned.length <= 200) return cleaned;
  const ext = fileExt(cleaned);
  return ext ? `${cleaned.slice(0, 195 - ext.length)}….${ext.toLowerCase()}` : cleaned.slice(0, 200);
}

async function sendFile(file) {
  const convId = state.activeId;
  if (!convId || !file) return;
  if (file.size > MAX_FILE_BYTES) {
    toast(`That file is ${formatSize(file.size)}. Files can be up to 25 MB.`);
    return;
  }
  if (!file.size) {
    toast('That file is empty.');
    return;
  }
  const type = (file.type || '').toLowerCase();
  const temp = newTemp(convId, {
    file_local: true, fileBlob: file, file_name: cleanFileName(file.name), file_size: file.size, file_type: MIME_RE.test(type) ? type : null,
  });
  clearReply();
  renderMessages(true);
  await deliverFile(temp);
}

async function deliverFile(temp) {
  const path = `${temp.conversation_id}/${crypto.randomUUID()}`;
  const bucket = supabase.storage.from('files');
  let data = null;
  let error = null;
  let uploaded = false;
  try {
    // Stored as plain bytes: the server never treats it as a web page or app.
    const up = await bucket.upload(path, temp.fileBlob, { contentType: 'application/octet-stream', upsert: false });
    if (up.error) throw up.error;
    uploaded = true;
    const row = {
      conversation_id: temp.conversation_id,
      body: '',
      file_path: path,
      file_name: temp.file_name,
      file_size: temp.file_size,
      file_type: temp.file_type,
    };
    if (temp.reply_to) row.reply_to = temp.reply_to;
    const res = await supabase.from('messages').insert(row).select(msgColumns()).single();
    if (res.error) throw res.error;
    data = res.data;
  } catch (e) {
    error = e;
    if (uploaded) bucket.remove([path]).catch(() => {});
  }
  settle(temp, data, error);
  if (error) toast(error?.statusCode === '413' || /exceeded|too large|size/i.test(error?.message || '')
    ? 'That file is too big for the free storage plan.'
    : "File didn't send. Tap it to try again.");
}

function fileCardEl(m, bubble, local) {
  const ext = fileExt(m.file_name);
  return h('button', {
    type: 'button',
    class: 'msg-file',
    'aria-label': local ? `File: ${m.file_name}` : `Download ${m.file_name}, ${formatSize(m.file_size)}`,
    onclick: (e) => { if (!local) { e.stopPropagation(); tapped(m, bubble, () => downloadFile(m)); } },
  },
  h('span', { class: 'file-icon', 'aria-hidden': 'true' }, ext || 'FILE'),
  h('span', { class: 'file-info' },
    h('strong', {}, m.file_name),
    h('span', {}, [formatSize(m.file_size), ext].filter(Boolean).join(' · '))));
}

// Always saved to your device as a download, never opened inside Boom Boom,
// so a file can't run anything here.
async function downloadFile(m) {
  if (!m.file_path || downloading.has(m.id)) return;
  downloading.add(m.id);
  toast(`Downloading ${m.file_name}…`);
  try {
    const { data, error } = await supabase.storage.from('files').download(m.file_path);
    if (error || !data) throw error || new Error('download failed');
    const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    const a = h('a', { href: url, download: cleanFileName(m.file_name).replace(/[:*?"<>|]/g, '_') });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    toast("Couldn't download it. Check your connection.");
  } finally {
    downloading.delete(m.id);
  }
}

// ---------------------------------------------------------------------
//  Stickers, made from your own photos
// ---------------------------------------------------------------------

let stickerEditing = false;

function stickerImgEl(path) {
  const img = h('img', { class: 'sticker-img', alt: 'Sticker', decoding: 'async' });
  blobUrl('stickers', path).then((url) => { img.src = url; }, () => { img.alt = "Sticker couldn't load"; });
  return img;
}

async function loadStickers() {
  if (!state.media) return;
  const { data, error } = await supabase.from('stickers').select('id, path').order('created_at', { ascending: false });
  if (!error) state.stickers = data;
}

async function openStickers() {
  stickerEditing = false;
  renderStickers();
  if (!$('dlg-stickers').open) $('dlg-stickers').showModal();
  await loadStickers();
  renderStickers();
}

function renderStickers() {
  const grid = $('sticker-grid');
  const tiles = [h('button', {
    type: 'button', class: 'sticker-tile sticker-new', 'aria-label': 'Make a new sticker from a photo',
    onclick: () => { $('dlg-stickers').close(); $('sticker-input').click(); },
  }, h('span', { 'aria-hidden': 'true' }, '+'), 'New')];
  for (const s of state.stickers) {
    tiles.push(h('button', {
      type: 'button',
      class: `sticker-tile${stickerEditing ? ' editing' : ''}`,
      'aria-label': stickerEditing ? 'Remove this sticker' : 'Send this sticker',
      onclick: () => (stickerEditing ? removeSticker(s) : sendSticker(s.path)),
    }, stickerImgEl(s.path), stickerEditing ? h('span', { class: 'sticker-x', 'aria-hidden': 'true' }, '×') : null));
  }
  grid.replaceChildren(...tiles);
  $('sticker-hint').hidden = state.stickers.length > 0;
  $('btn-sticker-edit').hidden = !state.stickers.length;
  $('btn-sticker-edit').textContent = stickerEditing ? 'Done' : 'Edit';
}

async function sendSticker(path) {
  $('dlg-stickers').close();
  const convId = state.activeId;
  if (!convId) return;
  const temp = newTemp(convId, { sticker_path: path });
  clearReply();
  renderMessages(true);
  await deliver(temp);
}

async function removeSticker(s) {
  const { data: unusedFile, error } = await supabase.rpc('remove_sticker', { p_id: s.id });
  if (error) {
    toast("Couldn't remove it. Check your connection.");
    return;
  }
  state.stickers = state.stickers.filter((x) => x.id !== s.id);
  if (unusedFile) supabase.storage.from('stickers').remove([unusedFile]).catch(() => {});
  if (!state.stickers.length) stickerEditing = false;
  renderStickers();
}

async function saveFriendSticker(m) {
  const { data: id, error } = await supabase.rpc('add_sticker', { p_path: m.sticker_path });
  if (error) {
    toast(isNetworkError(error) ? "Couldn't save it. Check your connection." : error.message);
    return;
  }
  if (!state.stickers.some((s) => s.id === id)) state.stickers.unshift({ id, path: m.sticker_path });
  toast('Saved to your stickers.');
}

async function saveNewSticker() {
  const item = compose.items[0];
  if (!item) return;
  compose.busy = true;
  composeStatus('Saving sticker…');
  try {
    let blob = await exportItem(item, { type: 'image/webp', quality: 0.9, size: 512 });
    if (blob.type !== 'image/webp') blob = await exportItem(item, { type: 'image/png', size: 512 }); // no WebP on this device
    const ext = blob.type === 'image/webp' ? 'webp' : 'png';
    const path = `${state.user.id}/${crypto.randomUUID()}.${ext}`;
    const bucket = supabase.storage.from('stickers');
    const up = await bucket.upload(path, blob, { contentType: blob.type, upsert: false, cacheControl: '31536000' });
    if (up.error) throw up.error;
    const { data: id, error } = await supabase.rpc('add_sticker', { p_path: path });
    if (error) {
      bucket.remove([path]).catch(() => {});
      throw error;
    }
    state.photoUrls.set(`stickers:${path}`, Promise.resolve(URL.createObjectURL(blob)));
    state.stickers = [{ id, path }, ...state.stickers.filter((x) => x.id !== id)];
    $('dlg-compose').close();
    await openStickers();
    toast('Sticker saved. Tap it to send.');
  } catch (error) {
    composeStatus(isNetworkError(error) ? "Couldn't save the sticker. Check your connection." : (error?.message || "Couldn't save the sticker."));
  } finally {
    compose.busy = false;
  }
}

// ---------------------------------------------------------------------
//  Chat wallpaper (just for you)
// ---------------------------------------------------------------------

const WALLS = [['', 'None'], ['pattern:dots', 'Dots'], ['pattern:grid', 'Grid'], ['pattern:stripes', 'Stripes'],
  ['pattern:waves', 'Waves'], ['pattern:confetti', 'Confetti'], ['pattern:glow', 'Glow']];
const WALL_CLASSES = ['has-wall', 'wall-photo', ...WALLS.filter(([v]) => v).map(([v]) => `wall-${v.slice(8)}`)];

async function loadWallpapers() {
  if (!state.media) return;
  const { data, error } = await supabase.from('chat_wallpapers').select('conversation_id, wallpaper');
  if (error) return;
  state.wallpapers = new Map(data.map((w) => [w.conversation_id, w.wallpaper]));
  applyWallpaper();
}

function applyWallpaper() {
  const box = $('messages');
  const conv = state.activeId;
  const value = (conv && state.wallpapers.get(conv)) || '';
  box.classList.remove(...WALL_CLASSES);
  box.style.removeProperty('--wall-photo');
  if (!value) return;
  box.classList.add('has-wall');
  if (value.startsWith('pattern:')) {
    box.classList.add(`wall-${value.slice(8)}`);
  } else if (value.startsWith('photo:')) {
    box.classList.add('wall-photo');
    blobUrl('wallpapers', value.slice(6)).then((url) => {
      if (state.activeId === conv && state.wallpapers.get(conv) === value) box.style.setProperty('--wall-photo', `url("${url}")`);
    }, () => {});
  }
}

function renderWallTiles() {
  const current = state.wallpapers.get(state.activeId) || '';
  const tiles = WALLS.map(([value, label]) => h('button', {
    type: 'button',
    class: `wall-tile${value ? ` wall-${value.slice(8)}` : ''}${value === current ? ' chosen' : ''}`,
    'aria-pressed': String(value === current),
    onclick: () => setWallpaper(value || null),
  }, h('span', {}, label)));
  const photoChosen = current.startsWith('photo:');
  const photoTile = h('button', {
    type: 'button',
    class: `wall-tile wall-own${photoChosen ? ' chosen' : ''}`,
    'aria-pressed': String(photoChosen),
    onclick: () => $('wall-input').click(),
  }, h('span', {}, photoChosen ? 'Change photo' : 'Your photo'));
  if (photoChosen) blobUrl('wallpapers', current.slice(6)).then((url) => { photoTile.style.backgroundImage = `url("${url}")`; }, () => {});
  $('wall-tiles').replaceChildren(...tiles, photoTile);
}

async function setWallpaper(value) {
  const conv = state.activeId;
  if (!conv) return false;
  const before = state.wallpapers.get(conv) || null;
  if (before === (value || null)) return true;
  const put = (v) => { if (v) state.wallpapers.set(conv, v); else state.wallpapers.delete(conv); applyWallpaper(); renderWallTiles(); };
  put(value);
  const { data: unused, error } = await supabase.rpc('set_wallpaper', { conv, p_wallpaper: value });
  if (error) {
    put(before);
    toast("Couldn't change the wallpaper. Check your connection.");
    return false;
  }
  if (unused) supabase.storage.from('wallpapers').remove([unused]).catch(() => {});
  return true;
}

async function setWallpaperPhoto(file) {
  const status = $('wall-status');
  status.textContent = 'Setting your wallpaper…';
  try {
    const blob = await makeWallpaper(file);
    const path = `${state.user.id}/${crypto.randomUUID()}.jpg`;
    const bucket = supabase.storage.from('wallpapers');
    const up = await bucket.upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
    if (up.error) throw up.error;
    state.photoUrls.set(`wallpapers:${path}`, Promise.resolve(URL.createObjectURL(blob)));
    if (!(await setWallpaper(`photo:${path}`))) bucket.remove([path]).catch(() => {});
  } catch (error) {
    toast(error?.code === 'unsupported' ? error.message : "Couldn't set the wallpaper. Check your connection.");
  } finally {
    status.textContent = 'Only you see it.';
  }
}

// ---------------------------------------------------------------------
//  What's new (shown once after an update, and any time from Settings)
// ---------------------------------------------------------------------

const WHATS_NEW = [
  {
    id: '2026-10-22', needs: 'media', date: '22 October 2026', title: 'Albums, doodles, stickers and more',
    items: [
      ['🖼️', 'Albums.', 'Pick several photos at once and they arrive together as one album. Swipe through them in the viewer.'],
      ['✂️', 'Crop, rotate, draw and write.', 'After picking a photo, use the buttons at the top to edit it before sending.'],
      ['✏️', 'Doodles.', 'Tap ⊕ next to the message box, then Doodle, and draw with your finger.'],
      ['😎', 'Stickers.', 'Tap ⊕, then Stickers, then New to turn a photo into a sticker. Press and hold a friend\'s sticker to save it.'],
      ['📎', 'Files.', 'Tap ⊕, then File, to send PDFs, documents and more, up to 25 MB.'],
      ['🎨', 'Wallpaper.', 'In a chat, tap ⋮ and pick a pattern or your own photo. Only you see it.'],
    ],
  },
  {
    id: '2026-10-21-b', needs: 'later', date: '21 October 2026', title: 'Send later, nicknames and gestures',
    items: [
      ['✍️', 'Text styling.', 'Type *bold*, _italic_ or ~strikethrough~.'],
      ['⏰', 'Send later.', 'Press and hold the send button to pick a time.'],
      ['🏷️', 'Nicknames.', 'In a chat, tap ⋮ then Nickname. Only you see it.'],
      ['👉', 'Swipe and double-tap.', 'Swipe a message right to reply. Double-tap it to ❤️.'],
      ['📅', 'On this day.', 'Every so often, a message from a year ago appears above your chats.'],
    ],
  },
  {
    id: '2026-10-21-a', history: true, date: '21 October 2026', title: 'Boom Boom begins',
    items: [
      ['💬', 'Chats', 'that arrive live, with notifications when the app is closed.'],
      ['📷', 'Full-quality photos,', 'with location and camera details removed first.'],
      ['❤️', 'Reactions, replies and unsend.', 'Press and hold a message.'],
      ['🙂', 'Profile pictures, typing…, edit, search and chat colours.', ''],
    ],
  },
];

const whatsNewKey = () => `boom-whats-new:${state.user?.id}`;

function seenWhatsNew() {
  try {
    return new Set(JSON.parse(localStorage.getItem(whatsNewKey()) || '[]'));
  } catch {
    return new Set();
  }
}

function maybeShowWhatsNew() {
  if (!state.started || document.querySelector('dialog[open]')) return;
  const seen = seenWhatsNew();
  const fresh = WHATS_NEW.filter((e) => !e.history && (!e.needs || state[e.needs]) && !seen.has(e.id));
  if (!fresh.length) return;
  showWhatsNew(fresh);
  try {
    localStorage.setItem(whatsNewKey(), JSON.stringify([...seen, ...fresh.map((e) => e.id)]));
  } catch { /* fine: it just shows again next time */ }
}

function showWhatsNew(entries = WHATS_NEW.filter((e) => !e.needs || state[e.needs])) {
  $('whatsnew-body').replaceChildren(...entries.map((e) => h('section', { class: 'whatsnew-entry' },
    h('h3', {}, e.title),
    h('p', { class: 'whatsnew-date' }, e.date),
    h('ul', { class: 'whatsnew-list' }, ...e.items.map(([icon, title, text]) => h('li', {},
      h('span', { class: 'whatsnew-icon', 'aria-hidden': 'true' }, icon),
      h('span', {}, h('strong', {}, title), text ? ` ${text}` : '')))))));
  $('dlg-whatsnew').showModal();
}

function wireMedia() {
  editor = new Editor($('compose-canvas'), { onChange: composeChanged, onText: openTextEntry });

  // ⊕ menu
  const fromAttach = (fn) => () => { $('dlg-attach').close(); fn(); };
  $('att-photos').addEventListener('click', fromAttach(() => $('photo-input').click()));
  $('att-doodle').addEventListener('click', fromAttach(() => openCompose('doodle')));
  $('att-sticker').addEventListener('click', fromAttach(openStickers));
  $('att-file').addEventListener('click', fromAttach(() => $('file-input').click()));
  $('file-input').addEventListener('change', (e) => {
    const [file] = e.target.files;
    e.target.value = '';
    if (file) sendFile(file);
  });
  $('sticker-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) openCompose('sticker', files);
  });

  // Edit screen
  $('compose-close').addEventListener('click', () => $('dlg-compose').close());
  $('dlg-compose').addEventListener('close', cleanUpCompose);
  $('compose-send').addEventListener('submit', finishCompose);
  $('compose-add-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    addComposeItems(files);
  });
  $('tool-undo').addEventListener('click', () => editor.undo());
  $('tool-rotate').addEventListener('click', () => editor.rotate());
  $('tool-crop').addEventListener('click', () => setComposeMode('crop'));
  $('tool-draw').addEventListener('click', () => setComposeMode('draw'));
  $('tool-text').addEventListener('click', () => {
    editor.setMode('text');
    renderComposeChrome();
    const c = editor.item?.crop || { x: 0, y: 0, w: 1, h: 1 };
    openTextEntry(null, [c.x + c.w / 2, c.y + c.h / 2]);
  });
  $('text-entry').addEventListener('submit', (e) => { e.preventDefault(); closeTextEntry(true); });
  $('text-entry-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTextEntry(false); }
  });
  $('opt-colours').replaceChildren(...COLOURS.map((colour, i) => h('button', {
    type: 'button', class: 'swatch small', style: `background:${colour}`, 'data-colour': colour, 'aria-label': COLOUR_NAMES[i],
    onclick: () => { editor.setColour(colour); renderComposeChrome(); },
  })));
  $('opt-brushes').replaceChildren(...Object.entries(BRUSHES).map(([name, px]) => h('button', {
    type: 'button', class: 'brush', 'data-size': px, 'aria-label': `${name[0].toUpperCase()}${name.slice(1)} brush`,
    onclick: () => { editor.brush = px; renderComposeChrome(); },
  }, h('span', { style: `width:${px + 4}px;height:${px + 4}px` }))));
  for (const b of $('opt-crop').querySelectorAll('[data-aspect]')) {
    b.addEventListener('click', () => { editor.setAspect(b.dataset.aspect === 'square' ? 1 : null); renderComposeChrome(); });
  }
  $('crop-reset').addEventListener('click', () => {
    if (!editor.item?.crop) return;
    editor.remember();
    editor.item.crop = null;
    editor.aspect = null;
    editor.setMode('crop');
    editor.changed();
  });
  for (const b of $('opt-shape').children) b.addEventListener('click', () => editor.setShape(b.dataset.shape));

  // Photo viewer: arrows, swipe and keyboard for albums
  $('viewer-prev').addEventListener('click', () => stepViewer(-1));
  $('viewer-next').addEventListener('click', () => stepViewer(1));
  $('dlg-photo').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') stepViewer(-1);
    if (e.key === 'ArrowRight') stepViewer(1);
  });
  let swipeFrom = null;
  $('viewer-img').addEventListener('pointerdown', (e) => { swipeFrom = e.clientX; });
  $('viewer-img').addEventListener('pointerup', (e) => {
    if (swipeFrom == null) return;
    const dx = e.clientX - swipeFrom;
    swipeFrom = null;
    if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
  });

  // Stickers
  $('btn-sticker-edit').addEventListener('click', () => { stickerEditing = !stickerEditing; renderStickers(); });

  // Wallpaper
  $('wall-input').addEventListener('change', (e) => {
    const [file] = e.target.files;
    e.target.value = '';
    if (file) setWallpaperPhoto(file);
  });

  // What's new
  $('btn-whats-new').addEventListener('click', () => {
    $('dlg-settings').close();
    showWhatsNew();
  });
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
