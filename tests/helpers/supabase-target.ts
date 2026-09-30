// The Supabase project the two database suites run against, checked to be
// a different project from the app's (scripts/supabase-test-target.mjs).
// Importing this throws before any test runs if SUPABASE_TEST_URL is the
// app's project, or if SUPABASE_TEST_SECRET_KEY is missing, isn't a secret
// key or is the app's, so a misconfigured .env.test can't spend the app's
// budget or run the worker against the app.

import { fileURLToPath } from "node:url";
import { supabaseTestTarget } from "../../scripts/supabase-test-target.mjs";

// Inside the Vitest "supabase" project, NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SECRET_KEY are the test project's, mapped there for the local
// worker runner (vitest.config.mts), so they are left out here: the app's
// project is read from its .env files and SUPABASE_APP_URL.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== "NEXT_PUBLIC_SUPABASE_URL" && name !== "SUPABASE_SECRET_KEY"),
);
const { url, publishableKey } = supabaseTestTarget(fileURLToPath(new URL("../..", import.meta.url)), env, {
  requireSecretKey: true,
});

export const SUPABASE_TEST_URL = url;
export const SUPABASE_TEST_PUBLISHABLE_KEY = publishableKey;

// The address a throwaway test user signs up with. Hosted Supabase refuses
// example and test domains ("Example and test domains are currently not
// supported"), so SUPABASE_TEST_EMAIL can name one real mailbox, and every
// user gets a plus-address on it: jane+extraction-x-1a2b3c4d@example.org.
// Email confirmation is off on the test project, so no mail is sent.
// Otherwise SUPABASE_TEST_EMAIL_DOMAIN (default example.com) is used as
// before, for projects that accept it.
export function testEmail(tag: string): string {
  const mailbox = process.env.SUPABASE_TEST_EMAIL;
  if (mailbox) {
    const at = mailbox.lastIndexOf("@");
    if (at <= 0) throw new Error("SUPABASE_TEST_EMAIL must be an email address.");
    return `${mailbox.slice(0, at)}+${tag}${mailbox.slice(at)}`;
  }
  return `${tag}@${process.env.SUPABASE_TEST_EMAIL_DOMAIN || "example.com"}`;
}
