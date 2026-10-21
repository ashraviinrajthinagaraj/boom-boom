// Boom Boom — send-push (Supabase Edge Function)
//
// The database calls this with { "message_id": 123 } every time someone sends
// a message. It looks that message up itself, then sends an encrypted
// notification to every device of everyone else in the chat.
//
// Setup (see README): deploy as "send-push" with JWT verification turned OFF,
// and add one secret, VAPID_PRIVATE_KEY. Open the function's URL in a browser
// to check it: it says whether the key is set up correctly.
//
// Notifications use the standard Web Push protocol (RFC 8030), encrypted with
// RFC 8291 and signed with VAPID (RFC 8292), using only built-in Web Crypto.

import { createClient } from "npm:@supabase/supabase-js@2";

// ==== core: begin (tested by supabase/tests/send_push_test.mts) ====

// Public half of the notification key. The app's config.js has the same value.
export const VAPID_PUBLIC_KEY = "BAr0n88LNFfdaTQQHgQA2mze3juapduWB1LimisUAY9Ugy9Wc7rqeXv-W_xzdNshToCRnWpLk6ZIBDCI55g_Uos";
export const VAPID_SUBJECT = "https://ashraviinrajthinagaraj.github.io/boom-boom/";

const MAX_AGE_MS = 10 * 60 * 1000; // only notify about messages from the last 10 minutes
const PREVIEW_CHARS = 180;
const te = new TextEncoder();

export interface Vapid {
  key: CryptoKey;
  publicKey: string;
  subject: string;
}

export interface Device {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function fromB64url(s: string): Uint8Array {
  const clean = s.trim();
  const b64 = clean.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((clean.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// HKDF-SHA-256 for outputs up to 32 bytes (all Web Push needs).
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmacSha256(salt, ikm);
  const okm = await hmacSha256(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

// RFC 8291: encrypt a payload so only the receiving browser can read it.
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublicB64: string,
  authSecretB64: string,
  opts: { serverKeys?: CryptoKeyPair; salt?: Uint8Array } = {},
): Promise<Uint8Array> {
  const uaPublic = fromB64url(uaPublicB64);
  const authSecret = fromB64url(authSecretB64);
  const serverKeys = opts.serverKeys ??
    await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, serverKeys.privateKey, 256),
  );
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const keyInfo = concat(te.encode("WebPush: info\0"), uaPublic, serverPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([2])); // single record, no padding
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, padded));

  const header = new Uint8Array(16 + 4 + 1 + serverPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096); // record size
  header[20] = serverPublic.length;
  header.set(serverPublic, 21);
  return concat(header, ciphertext);
}

// Load the private notification key and check it matches the public one.
export async function importVapid(privateB64: string | undefined, publicB64 = VAPID_PUBLIC_KEY, subject = VAPID_SUBJECT): Promise<Vapid> {
  if (!privateB64 || !privateB64.trim()) {
    throw new Error("The VAPID_PRIVATE_KEY secret is missing. Add it under Edge Functions → Secrets.");
  }
  const pub = fromB64url(publicB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID public key is not a valid P-256 key.");
  const mismatch = "VAPID_PRIVATE_KEY doesn't match this app's public key. Check you pasted it exactly.";
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: toB64url(pub.slice(1, 33)), y: toB64url(pub.slice(33, 65)), d: privateB64.trim() },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error(mismatch);
  }
  const probe = te.encode("boom-boom");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, probe);
  const verifier = await crypto.subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, sig, probe))) throw new Error(mismatch);
  return { key, publicKey: publicB64, subject };
}

// RFC 8292: signed header proving the notification comes from Boom Boom.
export async function vapidAuthorization(endpoint: string, vapid: Vapid, now = Date.now()): Promise<string> {
  const header = toB64url(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toB64url(te.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: vapid.subject,
  })));
  const unsigned = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.key, te.encode(unsigned)));
  return `vapid t=${unsigned}.${toB64url(sig)}, k=${vapid.publicKey}`;
}

export async function sendPush(device: Device, payload: string, vapid: Vapid, fetchFn: typeof fetch = fetch): Promise<Response> {
  const body = await encryptPayload(te.encode(payload), device.p256dh, device.auth);
  return fetchFn(device.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(device.endpoint, vapid),
      TTL: String(24 * 60 * 60),
      Urgency: "high",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body,
  });
}

function preview(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim()); // keeps emoji whole
  return chars.length > PREVIEW_CHARS ? chars.slice(0, PREVIEW_CHARS - 1).join("") + "…" : chars.join("");
}

// The whole job, given a database client. Returns an HTTP status and a summary.
// deno-lint-ignore no-explicit-any
export async function handleMessage(messageId: unknown, deps: { db: any; vapid: Vapid; fetchFn?: typeof fetch; now?: number }) {
  const { db } = deps;
  if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId <= 0) {
    return { status: 400, body: { error: "message_id must be a positive whole number" } };
  }

  const { data: msg, error: msgError } = await db
    .from("messages").select("id, conversation_id, sender_id, body, created_at").eq("id", messageId).maybeSingle();
  if (msgError) throw msgError;
  if (!msg) return { status: 200, body: { skipped: "no such message" } };
  if ((deps.now ?? Date.now()) - Date.parse(msg.created_at) > MAX_AGE_MS) {
    return { status: 200, body: { skipped: "message too old" } };
  }

  // Claim the message: only the first call for each message sends anything.
  const { error: claimError } = await db.from("push_log").insert({ message_id: msg.id });
  if (claimError) return { status: 200, body: { skipped: "already sent" } };

  const [senderRes, convRes, membersRes] = await Promise.all([
    db.from("profiles").select("display_name").eq("id", msg.sender_id).maybeSingle(),
    db.from("conversations").select("is_group, title").eq("id", msg.conversation_id).maybeSingle(),
    db.from("conversation_members").select("user_id").eq("conversation_id", msg.conversation_id).neq("user_id", msg.sender_id),
  ]);
  if (membersRes.error) throw membersRes.error;
  const recipients: string[] = (membersRes.data ?? []).map((m: { user_id: string }) => m.user_id);
  if (!recipients.length) return { status: 200, body: { sent: 0, devices: 0 } };

  const { data: devices, error: devError } = await db
    .from("push_subscriptions").select("id, endpoint, p256dh, auth").in("user_id", recipients);
  if (devError) throw devError;
  if (!devices?.length) return { status: 200, body: { sent: 0, devices: 0 } };

  const name = senderRes.data?.display_name ?? "Someone";
  const conv = convRes.data;
  const payload = JSON.stringify({
    title: conv?.is_group && conv?.title ? `${name} in ${conv.title}` : name,
    body: preview(msg.body),
    conversation_id: msg.conversation_id,
    message_id: msg.id,
  });

  let sent = 0, removed = 0, failed = 0;
  await Promise.all(devices.map(async (device: Device) => {
    try {
      const res = await sendPush(device, payload, deps.vapid, deps.fetchFn);
      if (res.ok) {
        sent++;
      } else if (res.status === 404 || res.status === 410) {
        // The browser unsubscribed (app removed, data cleared...). Forget the device.
        await db.from("push_subscriptions").delete().eq("id", device.id);
        removed++;
      } else {
        failed++;
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        console.error(`Push to device ${device.id} failed: HTTP ${res.status} ${detail}`);
      }
    } catch (e) {
      failed++;
      console.error(`Push to device ${device.id} failed:`, e);
    }
  }));

  return { status: 200, body: { sent, removed, failed, devices: devices.length } };
}

// ==== core: end ====

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// The server key lets this function read past the security rules.
function serverKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const first = Object.values(keys).find((v) => typeof v === "string");
    if (first) return first as string;
  } catch { /* fall back to the legacy key */ }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("No server key available to the function.");
}

let vapidReady: Promise<Vapid> | null = null;
function getVapid(): Promise<Vapid> {
  if (!vapidReady) {
    vapidReady = importVapid(Deno.env.get("VAPID_PRIVATE_KEY"));
    vapidReady.catch(() => { vapidReady = null; }); // retry after the secret is fixed
  }
  return vapidReady;
}

Deno.serve(async (req) => {
  try {
    if (req.method === "GET") {
      // Health check: open the function URL in a browser.
      try {
        await getVapid();
        return json({ ok: true, message: "send-push is running and the notification key is set up correctly." });
      } catch (e) {
        return json({ ok: false, problem: (e as Error).message }, 500);
      }
    }
    if (req.method !== "POST") return json({ error: "Use POST" }, 405);

    const input = await req.json().catch(() => ({}));
    const db = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await handleMessage(input?.message_id, { db, vapid: await getVapid() });
    return json(result.body, result.status);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});
