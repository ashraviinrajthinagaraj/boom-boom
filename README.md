# Boom Boom

Private, real-time messaging for a group of friends. Invite-only: there's no public sign-up page, so the only people inside are the ones you add.

Created by Ashraviinraj Thinagaraj.

## What it does

- One-to-one chats that arrive live, like any social media DM
- Unread badges, a count in the browser tab, and a little "boom" ripple when a message lands in another chat
- Works on phones and computers, in light and dark mode, and can be added to your home screen like an app
- Failed messages stay on screen with a tap-to-retry, and the app catches up on anything it missed after a dropped connection

## How it works

GitHub Pages hosts the website. GitHub can only serve files, so the live part runs on **Supabase** (free plan): it holds the accounts and messages, enforces the security rules, and pushes new messages to everyone who's online.

```
 Your phone ─┐                       ┌─ Supabase ──────────────────────┐
             ├─ GitHub Pages site ──►│  Accounts (email + password)    │
 Friend's ───┘   (this repo)         │  Database + security rules      │
 laptop                ◄── live ─────│  Realtime: pushes new messages  │
                                     └─────────────────────────────────┘
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

## Add it to your home screen

- **iPhone:** open the site in Safari → Share → **Add to Home Screen**
- **Android:** open it in Chrome → ⋮ menu → **Add to Home screen** (or **Install app**)

## Things to know

**The free project pauses after about a week of no activity.** Supabase emails you first. Your data is kept; open the project in the Supabase dashboard and press **Resume project**. Regular chatting keeps it awake.

**Messages are not end-to-end encrypted.** Whoever controls the Supabase project (you) can read them in the dashboard. Tell your friends, and don't give anyone else access to the dashboard.

**Resetting someone's password.** Password-reset emails hit the same email limits as invites, so do it yourself in the SQL Editor:

```sql
update auth.users
set encrypted_password = extensions.crypt('their-new-temporary-password', extensions.gen_salt('bf'))
where email = 'friend@example.com';
```

**Removing someone.** Deleting a user under **Authentication → Users** also deletes their profile and every message they sent.

**Limits in this version.** One-to-one chats only, text only, up to 4,000 characters per message, no editing or deleting. Phones only get new messages while Boom Boom is open (no push notifications yet).

## Ideas for later

- Group chats (the database is already shaped for them)
- Typing indicators and read receipts
- Photos
- Push notifications when the app is closed

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page: sign in, profile setup, chat list, chat, settings |
| `style.css` | All the styling, including dark mode |
| `app.js` | Everything the app does: sign-in, loading chats, sending, live updates |
| `config.js` | Your Supabase URL and publishable key |
| `manifest.webmanifest`, `icons/` | Home-screen name and icon |
| `supabase/schema.sql` | Tables, security rules and helper functions. Run once in Supabase |
| `supabase/tests/` | Automated checks of the security rules (see below) |

## Testing the security rules

`supabase/tests/security_tests.sql` runs 41 checks against the database rules: outsiders can't read or join chats, nobody can send as someone else, logged-out visitors get nothing, and so on. To run them you need a local PostgreSQL (version 15+):

```bash
createdb boomtest
psql -d boomtest -f supabase/tests/supabase_stub.sql   # imitates a fresh Supabase project
psql -d boomtest -f supabase/schema.sql
psql -d boomtest -f supabase/tests/security_tests.sql  # prints PASS / FAIL for each check
dropdb boomtest
```

Never run the test files against your real Supabase project.

---

Created by Ashraviinraj Thinagaraj.
