// Boom Boom — connection settings
//
// Get both values from Supabase: Project Settings → API Keys.
//   SUPABASE_URL  looks like  https://abcdefghijklmnop.supabase.co
//   SUPABASE_KEY  is the PUBLISHABLE key (starts with sb_publishable_)
//                 or, on older projects, the "anon" key.
//
// Both are safe to put on GitHub: the database's security rules decide who
// can read what. NEVER paste the secret key (sb_secret_...) or the
// service_role key here — those skip every security rule.

export const SUPABASE_URL = 'https://obzxdtgfsyidbnjwpmub.supabase.co';
export const SUPABASE_KEY = 'sb_publishable___VUtfCyvxTyRhQqdfM9Cg_jMYFrNd3';

// Public half of the notification key (safe to share). Its private half is
// the VAPID_PRIVATE_KEY secret on the send-push function, and the same public
// key is written at the top of supabase/functions/send-push/index.ts.
export const VAPID_PUBLIC_KEY = 'BAr0n88LNFfdaTQQHgQA2mze3juapduWB1LimisUAY9Ugy9Wc7rqeXv-W_xzdNshToCRnWpLk6ZIBDCI55g_Uos';
