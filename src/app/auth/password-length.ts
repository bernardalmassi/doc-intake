import { MIN_PASSWORD_LENGTH } from "@/lib/password";

// Supabase Auth refuses a password over 72 bytes (bcrypt's limit) with
// "Password cannot be longer than 72 characters". It measures bytes of
// UTF-8, so an accented letter counts as two and most emoji as four. The
// minimum, on the other hand, is checked by the sign-up action as
// password.length, so the count shown toward it is that same measure.
export const MAX_PASSWORD_BYTES = 72;

export type PasswordLength = { chars: number; bytes: number };

export const emptyPasswordLength: PasswordLength = { chars: 0, bytes: 0 };

export function measurePassword(value: string): PasswordLength {
  return { chars: value.length, bytes: new TextEncoder().encode(value).length };
}

export type LengthStatus = "empty" | "short" | "ok" | "long";

export function lengthStatus({ chars, bytes }: PasswordLength): LengthStatus {
  if (chars === 0) return "empty";
  if (chars < MIN_PASSWORD_LENGTH) return "short";
  if (bytes > MAX_PASSWORD_BYTES) return "long";
  return "ok";
}

// The error for a password over the limit. Without a length (the server
// said so) it can't say by how much.
export function tooLongMessage(length?: PasswordLength) {
  if (length && length.chars > MAX_PASSWORD_BYTES) {
    return `Too long: use at most ${MAX_PASSWORD_BYTES} characters. This has ${length.chars}.`;
  }
  return `Too long: use at most ${MAX_PASSWORD_BYTES} characters, counting accented letters, emoji and some symbols as two or more.`;
}

// For a polite live region. The text only changes when the status does, so
// a screen reader hears it when the rule is met or lost, not on every
// keystroke. "short" says nothing unless the minimum was met since the
// field was last empty, so the first keystrokes are quiet.
export function lengthAnnouncement(status: LengthStatus, reachedMin: boolean) {
  switch (status) {
    case "ok":
      return "Password is long enough.";
    case "long":
      return "Password is too long.";
    case "short":
      return reachedMin ? `Password is shorter than ${MIN_PASSWORD_LENGTH} characters.` : "";
    case "empty":
      return "";
  }
}
