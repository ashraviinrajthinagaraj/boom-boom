# Boom Boom

Private, real-time messaging for a group of friends. Invite-only: there's no public sign-up page, so the only people inside are the ones you add.

Created by Ashraviinraj Thinagaraj.

## What it does

- One-to-one chats that arrive live, like any social media DM
- Photos at full original quality, with your location and camera details removed first
- Reactions (👍 ❤️ 😂 😮 😢 🔥), replies that quote the original, and unsend for everyone
- Profile pictures, and "delete chat" (for you; your friend keeps their copy)
- Updates itself: when a new version is on GitHub, the app refreshes the next time you come back to it
- Unread badges, a count in the browser tab, and a little "boom" ripple when a message lands in another chat
- Notifications when someone messages you, even with Boom Boom closed. Tap one to jump straight into that chat
- Installs on your home screen like a real app, with an unread count on the icon where the phone supports it
- Works on phones and computers, in light and dark mode
- Failed messages stay on screen with a tap-to-retry, and the app catches up on anything it missed after a dropped connection

## How it works

GitHub Pages hosts the website. GitHub can only serve files, so the live part runs on **Supabase** (free plan): it holds the accounts and messages, enforces the security rules, and pushes new messages to everyone who's online.

```
 Your phone ─┐                       ┌─ Supabase ──────────────────────┐
             ├─ GitHub Pages site ──►│  Accounts (email + password)    │
 Friend's ───┘   (this repo)         │  Database + security rules      │
 laptop                ◄── live ─────│  Realtime: pushes new messages  │
                                     │  send-push: notifications when  │
       ◄── notification (via Google/ │  the app is closed              │
           Apple/Mozilla push) ──────└─────────────────────────────────┘
```

The security rules live in the database itself, so they hold even though the website's code is public:

- Logged-out visitors can't see anything.
- You only see chats you're in, and only their messages.
- You can only send as yourself, into your own chats, and you can't fake the time.
- Nobody can add themselves to someone else's chat.

## Setup (about 15 minutes)

### 1. Create a Supabase project

Sign up at [supabase.com](https://supabase.com), then **New project**. Name it `boom-boom`, save the database password somewhere safe, and pick the **Singapore** region (closest to Malaysia). The Free plan is enough.

### 2. Build the database

Open **SQL Editor → New query**, paste everything from [`supabase/schema.sql`](supabase/schema.sql), and press **Run**. You should see "Success. No rows returned." Run it only once.

### 3. Turn off public sign-ups

In **Authentication**, find the setting **Allow new users to sign up** and switch it off. Leave the Email sign-in method itself turned on.

### 4. Add your friends

**Authentication → Users → Add user → Create new user.** Enter their email and a temporary password, and tick **Auto Confirm User**. Do the same for yourself.

Send each friend their temporary password privately. After signing in, they pick a display name and username, and can change their password under Settings.

> Why not email invites? Supabase's built-in email only delivers to members of your own Supabase team and is heavily rate-limited, so invites wouldn't reach your friends unless you connect your own email provider. Creating accounts yourself avoids email entirely.

### 5. Connect the website to Supabase

Go to **Project Settings → API Keys** and copy:

- the **Project URL** (looks like `https://abcdefghijklmnop.supabase.co`)
- the **Publishable key** (starts with `sb_publishable_`; older projects call it the `anon` key)

Paste both into [`config.js`](config.js). Both are safe to publish.

**Never** paste the secret key (`sb_secret_…`) or the `service_role` key. They skip every security rule. The app refuses to start if it spots one.

### 6. Publish on GitHub Pages

In this repo on GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` and `/ (root)`, and save. After a minute or two the site is live at:

`https://ashraviinrajthinagaraj.github.io/boom-boom/`

### 7. Try it

Sign in on your phone, sign in as a friend on another device, and send a message. It should appear on the other screen within a second.

## Photos, reactions, replies and unsend (one-time server setup)

**SQL Editor → New query**: paste [`supabase/features.sql`](supabase/features.sql) and **Run**, once. It adds the private photo storage, reactions, replies and unsend. Until it's run, Boom Boom keeps working without these (the photo button stays hidden).

If you already deployed `send-push`, update it too so photo notifications say "📷 Photo" and unsent messages don't notify: **Edge Functions → send-push → Code**, paste the new [`index.ts`](supabase/functions/send-push/index.ts), deploy, then check **Settings → Verify JWT with legacy secret** is still **off**.

**Using them:** tap the picture icon to send photos. **Press and hold** a message (right-click or the **⋯** button on a computer) to react, reply, copy or unsend.

## Profile pictures and delete chat (one-time server setup)

**SQL Editor → New query**: paste [`supabase/avatars-and-delete.sql`](supabase/avatars-and-delete.sql) and **Run**, once (after `features.sql`). Until then, these two options stay hidden.

- **Profile picture:** **Settings → Your profile → Add a photo.** It's cropped to a centred square and re-saved on your phone, which also removes any hidden location or camera details. Only signed-in Boom Boom members can see it.
- **Delete chat:** open a chat and tap **⋮ → Delete chat** (tap twice). It disappears from *your* Boom Boom only. If they message you again, the chat comes back with just the new messages.

## Updates

Boom Boom checks for a new version whenever you come back to it, and every 15 minutes while it's open. If you're not in the middle of something, it reloads itself straight away (and reopens the chat you were in). If you're typing, a yellow **Boom Boom has been updated. Tap to refresh.** button appears instead, and your half-written message is kept.

## Notifications (one-time server setup)

Notifications need one extra piece on Supabase: a small function, `send-push`, that the database calls whenever someone sends a message.

1. **SQL Editor → New query**: paste [`supabase/push.sql`](supabase/push.sql) and **Run**. Run it once.
2. **Edge Functions → Deploy a new function → Via Editor.** Name it exactly `send-push`. Delete the starter code, paste everything from [`supabase/functions/send-push/index.ts`](supabase/functions/send-push/index.ts), and press **Deploy function**.
3. **Turn off JWT verification for `send-push`** (in the function's settings it's called *Enforce JWT verification* or *Verify JWT*). The database calls it without logging in. That's safe: the function ignores what it's sent except a message number, looks the message up itself, and only ever notifies about a real message from the last few minutes, once.
4. **Edge Functions → Secrets**: add `VAPID_PRIVATE_KEY` with the private notification key. It is deliberately not in this repo. Keep it private.
5. **Check it:** open `https://<your-project>.supabase.co/functions/v1/send-push` in a browser. It should say `"ok": true`. If not, it tells you what's wrong.

Then each person turns notifications on for their own device: Boom Boom shows a **Turn on** banner, or use **Settings → Notifications**.

**Lost the private key?** Make a new pair, put the public half in `config.js` *and* at the top of `send-push/index.ts`, redeploy the function, update the secret, and ask everyone to turn notifications off and on again:

```bash
node -e 'crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign"]).then(async k=>{const r=new Uint8Array(await crypto.subtle.exportKey("raw",k.publicKey));console.log("public: "+Buffer.from(r).toString("base64url"));console.log("private:",(await crypto.subtle.exportKey("jwk",k.privateKey)).d)})'
```

## Install it like an app

- **Android:** Boom Boom offers an **Install** button (banner or **Settings → Install the app**). Otherwise: Chrome ⋮ menu → **Install app** / **Add to Home screen**.
- **iPhone:** in Safari, Share → **Add to Home Screen**, then open Boom Boom from the Home Screen. iPhones only allow website notifications for apps added this way (iOS 16.4 or newer).
- **Computers:** use the install icon in Chrome or Edge's address bar.

## Things to know

**The free project pauses after about a week of no activity.** Supabase emails you first. Your data is kept; open the project in the Supabase dashboard and press **Resume project**. Regular chatting keeps it awake.

**Messages are not end-to-end encrypted.** Whoever controls the Supabase project (you) can read them in the dashboard. Tell your friends, and don't give anyone else access to the dashboard.

**Resetting someone's password.** Password-reset emails hit the same email limits as invites, so do it yourself in the SQL Editor:

```sql
update auth.users
set encrypted_password = extensions.crypt('their-new-temporary-password', extensions.gen_salt('bf'))
where email = 'friend@example.com';
```

**Removing someone.** Deleting a user under **Authentication → Users** also deletes their profile and every message they sent. Their one-to-one chats disappear from everyone's list. Their photo files stay in **Storage → photos** until you delete them there.

**Photos and privacy.**
- *Hidden details are removed on your phone, before upload*: GPS location, phone make and model, date and time, editing software, comments and embedded previews. Only the colour profile and the rotation flag are kept.
- *Full quality*: for JPEG, PNG, WebP and GIF the picture data is copied byte for byte, not re-compressed. Other formats (like HEIC) become a high-quality JPEG.
- *Who can see a photo*: only people in that chat, and you as the Supabase owner. The bucket is private and there are no public links; photos load only for signed-in members.
- *Unsend* deletes the photo files from the server. It can't undo a screenshot, a saved copy, or a notification someone already saw.
- *Storage*: the Free plan has 1 GB of file storage and 5 GB of downloads a month. At full quality that's very roughly 200–400 phone photos. Chats show a small preview, and the full photo only downloads when someone opens it. When storage fills up, sending photos fails until you delete some (Storage in the dashboard) or upgrade.
- Photos aren't end-to-end encrypted, the same as messages.

**Notifications show the message text** on the lock screen, like most messaging apps. They travel through Google's, Apple's or Mozilla's push service encrypted, so those services can't read them.

**Limits in this version.** One-to-one chats only. Messages up to 4,000 characters, photos up to 50 MB. Unsent messages leave a "message unsent" marker; there's no editing.

## Ideas for later

- Group chats (the database is already shaped for them)
- Typing indicators and read receipts

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page: sign in, profile setup, chat list, chat, settings |
| `style.css` | All the styling, including dark mode |
| `app.js` | Everything the app does: sign-in, chats, sending, photos, reactions, replies, unsend, live updates |
| `photo.js` | Removes location and camera details from photos without losing quality; makes previews |
| `config.js` | Your Supabase URL and publishable key |
| `sw.js` | Service worker: shows notifications and opens the right chat when you tap one |
| `manifest.webmanifest`, `icons/` | App name and icons for installing |
| `supabase/schema.sql` | Tables, security rules and helper functions. Run once in Supabase |
| `supabase/push.sql` | Notification devices and the trigger that calls send-push. Run once |
| `supabase/features.sql` | Private photo storage, reactions, replies and unsend. Run once |
| `supabase/avatars-and-delete.sql` | Profile pictures and delete chat. Run once |
| `supabase/functions/send-push/` | The notification sender (Supabase Edge Function) |
| `supabase/tests/`, `tests/` | Automated checks (see below) |

## Testing

**Database rules** (123 checks: outsiders can't read or join chats or see their photos, nobody can send, react or unsend as someone else, a failing notification never blocks a message...). You need a local PostgreSQL (version 15+). Use a fresh database for each test file:

```bash
createdb boomtest
psql -d boomtest -f supabase/tests/supabase_stub.sql   # imitates a fresh Supabase project
psql -d boomtest -f supabase/tests/net_stub.sql        # stands in for pg_net
psql -d boomtest -f supabase/tests/storage_stub.sql    # stands in for Supabase Storage
psql -d boomtest -f supabase/schema.sql
grep -v 'create extension if not exists pg_net' supabase/push.sql | psql -d boomtest
psql -d boomtest -f supabase/features.sql
psql -d boomtest -f supabase/avatars-and-delete.sql
psql -d boomtest -f supabase/tests/security_tests.sql  # or push_tests / features_tests / avatars_delete_tests
dropdb boomtest
```

**Photo privacy** (30 checks with real photos full of GPS, camera and comment data, verified pixel for pixel with an independent image library). Needs Python with Pillow:

```bash
python3 tests/photo_test.py
```

**Notification sender** (encryption checked byte-for-byte against the official RFC 8291 example) and **service worker**, with Node 22+:

```bash
node --experimental-strip-types supabase/tests/send_push_test.mts
node tests/sw_test.mjs
```

Never run the test files against your real Supabase project.

---

Created by Ashraviinraj Thinagaraj.
