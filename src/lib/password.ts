// Mirrors the minimum set in the Supabase dashboard (Authentication >
// Sign In / Providers > Email). The server enforces it; the form only
// checks it early and explains it. Lives outside the "use server" module
// because such modules may only export async functions.
export const MIN_PASSWORD_LENGTH = 15;

// Supabase Auth hashes passwords with bcrypt, which reads at most 72 bytes,
// so it refuses anything longer. Bytes, not characters: an accented letter
// is two bytes in UTF-8 and an emoji four.
export const MAX_PASSWORD_BYTES = 72;
