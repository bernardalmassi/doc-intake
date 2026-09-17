// Mirrors the minimum set in the Supabase dashboard (Authentication >
// Sign In / Providers > Email). The server enforces it; the form only
// checks it early and explains it. Lives outside the "use server" module
// because such modules may only export async functions.
export const MIN_PASSWORD_LENGTH = 15;
