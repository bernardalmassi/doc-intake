// NEXT_PUBLIC_ vars are inlined at build time only when referenced literally,
// so read them here by name rather than through a dynamic lookup.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env.local and fill them in.",
  );
}

export const supabaseUrl = url;
export const supabasePublishableKey = publishableKey;
