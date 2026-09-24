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

// The rule under the password field, before anything is submitted: a count
// toward the minimum that turns into a check once it's met. Referenced by
// the field's aria-describedby, so it is read with the field; changes are
// announced separately, by a live region holding `announcement`.
export function PasswordRule({ id, length }: { id: string; length: PasswordLength }) {
  const met = length.chars >= MIN_PASSWORD_LENGTH;
  return (
    <p id={id} className="mt-1 flex items-center gap-1.5 text-small">
      {met ? <CheckIcon /> : <CircleIcon />}
      <span className={met ? "text-ink" : "text-ink"}>
        At least {MIN_PASSWORD_LENGTH} characters
        {met && <span className="sr-only">, done</span>}
      </span>
      {length.chars > 0 && !met && (
        <span className="text-ink tabular-nums">
          <span aria-hidden="true">·</span>
          <span className="sr-only">,</span> {length.chars} of {MIN_PASSWORD_LENGTH}
        </span>
      )}
    </p>
  );
}

function CircleIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className="shrink-0 text-ink"
    >
      <circle cx="8" cy="8" r="5.25" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-ink"
    >
      <circle cx="8" cy="8" r="5.25" />
      <path d="M5.75 8.1l1.6 1.6 2.9-3.2" />
    </svg>
  );
}
