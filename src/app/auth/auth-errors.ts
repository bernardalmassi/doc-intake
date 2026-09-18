// What the sign-in and sign-up forms show for an error, and where. The
// Server Actions in ./actions.ts return either their own sentence or
// Supabase's message as is; this maps the known ones to plain English at
// render time and attaches them to the field they are about. Anything not
// listed here is shown as it came, next to the submit button.
//
// The Supabase messages are the Auth server's own strings
// (github.com/supabase/auth, internal/api), matched exactly.

import { tooLongMessage } from "./password-length";

export type Field = "email" | "password";

// At most one message per place. "form" is the message by the submit
// button, for anything that isn't about one field.
export type Problems = Partial<Record<Field | "form", string>>;

// The browser never got an answer from our server: the connection dropped,
// or the server failed before the action could return. Set by the form,
// not by an action.
export const CONNECTION_ERROR =
  "Something went wrong while sending the form. Check your connection and try again.";

type Rule = {
  match: string | RegExp;
  // Where the message goes. Defaults to "form".
  field?: Field;
  // What to show instead. Omitted: show the original.
  text?: string;
};

const SERVICE_UNAVAILABLE = "We couldn’t reach the account service. Try again in a moment.";

const rules: Rule[] = [
  // Supabase doesn't say which of the two was wrong, on purpose, so neither
  // field is marked.
  {
    match: "Invalid login credentials",
    text: "Wrong email or password. Check both and try again.",
  },
  {
    match: "Email not confirmed",
    text: "Your email address isn’t confirmed yet. Open the link in the email we sent you, or create an account again with the same address to get a new link.",
  },
  {
    match: "Request rate limit reached",
    text: "Too many attempts. Wait a few minutes, then try again.",
  },
  // The server couldn't reach Supabase: Node's fetch error, or a 5xx whose
  // body wasn't JSON (auth-js then reports the status text).
  {
    match: /^(fetch failed|HTTP 5\d\d|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)$/,
    text: SERVICE_UNAVAILABLE,
  },

  // Sign-up. With email confirmation on, Supabase answers a sign-up for an
  // existing address as if it were new, so this only appears when it's off.
  {
    match: "User already registered",
    field: "email",
    text: "There’s already an account with this email address. Sign in instead.",
  },
  {
    match: /^Unable to validate email address/,
    field: "email",
    text: "Enter a full email address, like name@example.com.",
  },
  {
    match: /^Email address ".*" is invalid$/,
    field: "email",
    text: "This email address can’t be used. Check it for typos, or use a different one.",
  },
  // Supabase's built-in email service only sends to addresses the project
  // allows; anything else is refused before an account is made.
  {
    match: /^Email address ".*" cannot be used as it is not authorized$/,
    field: "email",
    text: "For now, only approved email addresses can sign up, and this isn’t one of them.",
  },
  {
    match: "An email address is too long",
    field: "email",
    text: "That email address is too long.",
  },
  {
    match: "email rate limit exceeded",
    text: "Too many sign-up emails have gone out in the last hour. Try again later.",
  },
  {
    match: /^(Signups not allowed for this instance|Email signups are disabled)$/,
    text: "New accounts can’t be created right now.",
  },
  {
    match: /^Password cannot be longer than \d+ characters$/,
    field: "password",
    text: tooLongMessage(),
  },
  // The action's own sentences about a rejected password ("Password
  // rejected: it must…", "Password is too short.") and Supabase's
  // ("Password should be at least…"), shown as they are, on the field.
  { match: /^Password\b/, field: "password" },
];

function matches(rule: Rule, raw: string) {
  return typeof rule.match === "string" ? rule.match === raw : rule.match.test(raw);
}

export function describeAuthError(raw: string): Problems {
  const rule = rules.find((r) => matches(r, raw));
  return { [rule?.field ?? "form"]: rule?.text ?? raw };
}
