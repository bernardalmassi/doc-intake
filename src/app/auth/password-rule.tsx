"use client";

import { useState } from "react";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import {
  emptyPasswordLength,
  lengthAnnouncement,
  lengthStatus,
  measurePassword,
  type PasswordLength,
} from "./password-length";

// Follows a password field's length as it's typed, for the rule below it.
// Only the length is kept, never the value. Pass onChange to the input and
// call reset when the field is emptied from outside (a form reset).
export function usePasswordLength() {
  const [length, setLength] = useState<PasswordLength>(emptyPasswordLength);
  // Whether the minimum has been met since the field was last empty, so
  // that falling below it again is announced but the first keystrokes
  // aren't.
  const [reachedMin, setReachedMin] = useState(false);
  const status = lengthStatus(length);

  function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = measurePassword(event.target.value);
    setLength(next);
    if (next.chars === 0) setReachedMin(false);
    else if (next.chars >= MIN_PASSWORD_LENGTH) setReachedMin(true);
  }

  function reset() {
    setLength(emptyPasswordLength);
    setReachedMin(false);
  }

  return { length, status, announcement: lengthAnnouncement(status, reachedMin), onChange, reset };
}

// The rule under the password field, before anything is submitted: the
// minimum, then a count toward it as the password is typed, then "met"
// once it's reached. Words, not a circle that turns into a tick: the
// register uses no ticks, and the count says more. Referenced by the
// field's aria-describedby, so it is read with the field; changes are
// announced separately, by a live region holding `announcement`.
export function PasswordRule({ id, length }: { id: string; length: PasswordLength }) {
  const met = length.chars >= MIN_PASSWORD_LENGTH;
  return (
    <p id={id} className="mt-3 text-small text-ink">
      At least {MIN_PASSWORD_LENGTH} characters
      {length.chars > 0 && (
        <>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          {met ? "met" : `${length.chars} of ${MIN_PASSWORD_LENGTH}`}
        </>
      )}
    </p>
  );
}
