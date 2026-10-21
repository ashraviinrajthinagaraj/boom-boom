// Checks for supabase/functions/send-push/index.ts, runnable with Node 22+:
//   node --experimental-strip-types supabase/tests/send_push_test.mts
// Tests the encryption against the official example in RFC 8291 (Appendix A),
// checks the VAPID signature with Node's own crypto, decrypts a real payload
// the way a browser would, and runs the message handler against a fake database.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import nodeCrypto from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../functions/send-push/index.ts"), "utf8");
const start = source.indexOf("// ==== core: begin");
const end = source.indexOf("// ==== core: end ====");
if (start < 0 || end < 0) throw new Error("core markers not found in index.ts");
const dir = mkdtempSync(join(tmpdir(), "send-push-"));
const corePath = join(dir, "core.mts");
writeFileSync(corePath, source.slice(start, end));
const core = await import(pathToFileURL(corePath).href);

const results: string[] = [];
const check = (cond: boolean, label: string) => results.push(`${cond ? "PASS" : "FAIL"}  ${label}`);
const b = core.fromB64url;
const eq = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i]);

// ---------- 1. RFC 8291 Appendix A ----------
{
  const v = {
    plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
    asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
    body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  };
  const pub = b(v.asPublic);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: v.asPrivate, x: core.toB64url(pub.slice(1, 33)), y: core.toB64url(pub.slice(33)) },
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const out = await core.encryptPayload(b(v.plaintext), v.uaPublic, v.auth, { serverKeys: { privateKey, publicKey }, salt: b(v.salt) });
  check(eq(out, b(v.body)), "Encryption matches the official RFC 8291 example byte for byte");
}

// ---------- 2. Browser-side decryption of a real payload ----------
async function hmac(key: Uint8Array, data: Uint8Array) {
  return new Uint8Array(nodeCrypto.createHmac("sha256", key).update(data).digest());
}
async function browserDecrypt(body: Uint8Array, uaPrivate: nodeCrypto.ECDH, uaPublic: Uint8Array, authSecret: Uint8Array) {
  // Written independently from the sender, with Node's crypto module.
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const shared = new Uint8Array(uaPrivate.computeSecret(asPublic));
  const info = (s: string) => new TextEncoder().encode(s);
  const prkKey = await hmac(authSecret, shared);
  const ikm = (await hmac(prkKey, Buffer.concat([info("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, Buffer.concat([info("Content-Encoding: aes128gcm\0"), Buffer.from([1])]))).slice(0, 16);
  const nonce = (await hmac(prk, Buffer.concat([info("Content-Encoding: nonce\0"), Buffer.from([1])]))).slice(0, 12);
  const decipher = nodeCrypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.slice(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.slice(0, -16)), decipher.final()]);
  const last = padded.lastIndexOf(2);
  return { rs, text: padded.slice(0, last).toString("utf8"), delimiterOk: padded.slice(last + 1).every((x) => x === 0) };
}
{
  const ua = nodeCrypto.createECDH("prime256v1");
  ua.generateKeys();
  const uaPublic = new Uint8Array(ua.getPublicKey());
  const authSecret = new Uint8Array(nodeCrypto.randomBytes(16));
  const message = JSON.stringify({ title: "Bala", body: "Library at 4? 📚" });
  const body = await core.encryptPayload(new TextEncoder().encode(message), core.toB64url(uaPublic), core.toB64url(authSecret));
  const got = await browserDecrypt(body, ua, uaPublic, authSecret);
  check(got.text === message && got.delimiterOk && got.rs === 4096, "A browser can decrypt the notification (emoji intact)");
  const body2 = await core.encryptPayload(new TextEncoder().encode(message), core.toB64url(uaPublic), core.toB64url(authSecret));
  check(!eq(body, body2), "Every notification is encrypted with fresh keys");
}

// ---------- 3. VAPID ----------
const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const testPublic = core.toB64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey)));
const testPrivate = (await crypto.subtle.exportKey("jwk", vapidPair.privateKey)).d as string;
const vapid = await core.importVapid(testPrivate, testPublic, "https://example.com/boom-boom/");
{
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
  const header = await core.vapidAuthorization(endpoint, vapid, Date.UTC(2026, 9, 21, 10, 0, 0));
  const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  check(!!m && m[4] === testPublic, "Authorization header has the vapid t=…, k=… shape");
  if (m) {
    const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
    const head = JSON.parse(Buffer.from(m[1], "base64url").toString());
    check(head.alg === "ES256" && claims.aud === "https://fcm.googleapis.com" && claims.sub === "https://example.com/boom-boom/"
      && claims.exp === Date.UTC(2026, 9, 21, 22, 0, 0) / 1000, "Token says who it's for, who sent it, and expires in 12 hours");
    const keyObj = nodeCrypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: core.toB64url(b(testPublic).slice(1, 33)), y: core.toB64url(b(testPublic).slice(33)) }, format: "jwk" });
    const valid = nodeCrypto.verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key: keyObj, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url"));
    check(valid, "Signature verifies with an independent ES256 check");
  }
  let missing = "";
  try { await core.importVapid(""); } catch (e) { missing = (e as Error).message; }
  check(missing.includes("missing"), "A missing private key gives a clear message");
  const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const otherD = (await crypto.subtle.exportKey("jwk", other.privateKey)).d as string;
  let wrong = "";
  try { await core.importVapid(otherD, testPublic); } catch (e) { wrong = (e as Error).message; }
  check(wrong.includes("doesn't match"), "A wrong private key is caught before sending anything");
}

// ---------- 4. Message handler against a fake database ----------
type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>, log: string[]) {
  class Q {
    filters: ((r: Row) => boolean)[] = [];
    action = "select";
    payload: Row | null = null;
    table: string;
    constructor(table: string) { this.table = table; }
    select() { return this; }
    insert(p: Row) { this.action = "insert"; this.payload = p; return this; }
    delete() { this.action = "delete"; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
    neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    maybeSingle() { return this.run(true); }
    then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return this.run(false).then(res, rej); }
    async run(single: boolean) {
      const rows = tables[this.table] ??= [];
      if (this.action === "insert") {
        if (this.table === "push_log") {
          if (rows.some((r) => r.message_id === this.payload!.message_id)) return { data: null, error: { code: "23505" } };
          if (!tables.messages.some((m) => m.id === this.payload!.message_id)) return { data: null, error: { code: "23503" } };
        }
        rows.push({ ...this.payload });
        return { data: null, error: null };
      }
      const hits = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.action === "delete") {
        tables[this.table] = rows.filter((r) => !hits.includes(r));
        log.push(`delete ${this.table} ${hits.map((h) => h.id).join(",")}`);
        return { data: null, error: null };
      }
      return { data: single ? hits[0] ?? null : hits, error: null };
    }
  }
  return { from: (t: string) => new Q(t) };
}

{
  const now = Date.UTC(2026, 9, 21, 10, 0, 0);
  const A = "user-a", B = "user-b", C = "user-c";
  const devB1 = nodeCrypto.createECDH("prime256v1"); devB1.generateKeys();
  const devB2 = nodeCrypto.createECDH("prime256v1"); devB2.generateKeys();
  const devA = nodeCrypto.createECDH("prime256v1"); devA.generateKeys();
  const authB1 = nodeCrypto.randomBytes(16);
  const longText = "Weighing mechanisms vs impacts 🔥 ".repeat(10);
  const tables: Record<string, Row[]> = {
    messages: [
      { id: 7, conversation_id: "conv1", sender_id: A, body: longText, created_at: new Date(now - 5000).toISOString() },
      { id: 3, conversation_id: "conv1", sender_id: A, body: "old one", created_at: new Date(now - 3600_000).toISOString() },
    ],
    profiles: [{ id: A, display_name: "Ashraviinraj" }],
    conversations: [{ id: "conv1", is_group: false, title: null }],
    conversation_members: [{ conversation_id: "conv1", user_id: A }, { conversation_id: "conv1", user_id: B }],
    push_subscriptions: [
      { id: 1, user_id: B, endpoint: "https://fcm.googleapis.com/fcm/send/b1", p256dh: core.toB64url(new Uint8Array(devB1.getPublicKey())), auth: core.toB64url(new Uint8Array(authB1)) },
      { id: 2, user_id: B, endpoint: "https://web.push.apple.com/b2", p256dh: core.toB64url(new Uint8Array(devB2.getPublicKey())), auth: core.toB64url(new Uint8Array(nodeCrypto.randomBytes(16))) },
      { id: 3, user_id: A, endpoint: "https://fcm.googleapis.com/fcm/send/a1", p256dh: core.toB64url(new Uint8Array(devA.getPublicKey())), auth: core.toB64url(new Uint8Array(nodeCrypto.randomBytes(16))) },
      { id: 4, user_id: C, endpoint: "https://fcm.googleapis.com/fcm/send/c1", p256dh: core.toB64url(new Uint8Array(devA.getPublicKey())), auth: core.toB64url(new Uint8Array(nodeCrypto.randomBytes(16))) },
    ],
    push_log: [],
  };
  const log: string[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status: url.includes("apple") ? 410 : 201 });
  }) as unknown as typeof fetch;
  const db = fakeDb(tables, log);

  const r1 = await core.handleMessage(7, { db, vapid, fetchFn, now });
  check(r1.status === 200 && r1.body.sent === 1 && r1.body.removed === 1, `New message: notifies B's devices only (${JSON.stringify(r1.body)})`);
  check(calls.length === 2 && calls.every((c) => !c.url.endsWith("/a1") && !c.url.endsWith("/c1")), "Sender and people outside the chat get nothing");
  check(log.includes("delete push_subscriptions 2"), "A device that was uninstalled (410) is forgotten");
  const h = calls[0].init.headers as Record<string, string>;
  check(h["Content-Encoding"] === "aes128gcm" && h.TTL === "86400" && h.Urgency === "high" && h.Authorization.startsWith("vapid t="), "Push request has the right headers");
  const b1Call = calls.find((c) => c.url.endsWith("/b1"))!;
  const decrypted = await browserDecrypt(b1Call.init.body as Uint8Array, devB1, new Uint8Array(devB1.getPublicKey()), new Uint8Array(authB1));
  const payload = JSON.parse(decrypted.text);
  check(payload.title === "Ashraviinraj" && payload.conversation_id === "conv1" && payload.message_id === 7, "B's phone can read who it's from and which chat");
  check(Array.from(payload.body as string).length === 180 && (payload.body as string).endsWith("…") && !(payload.body as string).includes("�"), "Long messages are trimmed to a preview without breaking emoji");

  const r2 = await core.handleMessage(7, { db, vapid, fetchFn, now });
  check(r2.body.skipped === "already sent" && calls.length === 2, "Calling twice for the same message sends nothing more");
  const r3 = await core.handleMessage(3, { db, vapid, fetchFn, now });
  check(r3.body.skipped === "message too old", "Old messages are ignored");
  const r4 = await core.handleMessage(999, { db, vapid, fetchFn, now });
  check(r4.body.skipped === "no such message", "Made-up message ids are ignored");
  const r5 = await core.handleMessage("7; drop table", { db, vapid, fetchFn, now });
  check(r5.status === 400, "Junk input is rejected");

  // Photos and unsent messages
  tables.messages.push(
    { id: 8, conversation_id: "conv1", sender_id: A, body: "", photo_path: "conv1/x.jpg", created_at: new Date(now - 1000).toISOString() },
    { id: 9, conversation_id: "conv1", sender_id: A, body: "", deleted_at: new Date(now).toISOString(), created_at: new Date(now - 1000).toISOString() },
  );
  const before = calls.length;
  await core.handleMessage(8, { db, vapid, fetchFn, now });
  const photoCall = calls.slice(before).find((c) => c.url.endsWith("/b1"))!;
  const photoPayload = JSON.parse((await browserDecrypt(photoCall.init.body as Uint8Array, devB1, new Uint8Array(devB1.getPublicKey()), new Uint8Array(authB1))).text);
  check(photoPayload.body === "📷 Photo", "Photo notifications say 📷 Photo and never include the image");
  const r9 = await core.handleMessage(9, { db, vapid, fetchFn, now });
  check(r9.body.skipped === "message was unsent", "Unsent messages don't trigger a notification");

  // Albums, files and stickers get a label, never the contents
  const two = [{ path: "a" }, { path: "b" }, { path: "c" }];
  check(core.label({ photo_path: "conv1/a.jpg", album: two }, "") === "📷 3 photos", "Albums say how many photos");
  check(core.label({ photo_path: "conv1/a.jpg", album: two }, "Tournament day") === "📷 3 photos: Tournament day", "...with the caption");
  check(core.label({ file_path: "conv1/f", file_name: "Motion prep.pdf" }, "") === "📎 Motion prep.pdf", "Files show their name");
  check(core.label({ sticker_path: "u/s.webp" }, "") === "Sticker", "Stickers say Sticker");
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
