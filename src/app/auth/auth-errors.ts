// Where the sign-in and sign-up forms show an error. The Server Actions in
// ./actions.ts return a code from src/lib/errors.ts, never Supabase's text;
// the words are the catalog's, and this only decides which field a code is
// about. Anything not about one field goes next to the submit button.

import { type ErrorCode, userFacingError } from "@/lib/errors";

export type Field = "email" | "password";

// At most one message per place. "form" is the message by the submit
// button, for anything that isn't about one field.
export type Problems = Partial<Record<Field | "form", string>>;

const FIELD_OF: Partial<Record<ErrorCode, Field>> = {
  "auth.password_too_short": "password",
  "auth.password_too_long": "password",
  "auth.password_missing_characters": "password",
  "auth.password_breached": "password",
  "auth.password_weak": "password",
  "auth.email_taken": "email",
  "auth.email_invalid": "email",
  "auth.email_not_allowed": "email",
};

// Supabase doesn't say which of email and password was wrong, on purpose,
// so auth.invalid_credentials marks neither field.
export function placeAuthError(code: ErrorCode): Problems {
  return { [FIELD_OF[code] ?? "form"]: userFacingError(code).message };
}
