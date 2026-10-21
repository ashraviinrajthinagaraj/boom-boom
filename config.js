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
