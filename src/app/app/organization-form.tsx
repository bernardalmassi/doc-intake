"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  errorClass,
  errorInkRuleClass,
  formRowClass,
  formRowLabelClass,
  hintClass,
  inputClass,
  submitButtonClass,
} from "@/app/ui";
import { type ErrorCode, SLUG_PATTERN, userFacingError } from "@/lib/errors";
import { SLUG_MAX_LENGTH, slugify } from "@/lib/slug";

// The web address rule is the tenants.slug check constraint, mirrored in
// src/lib/errors.ts. Native validation enforces it before submit with the
// same words the server's answer would use; the server checks it again.
const ADDRESS_RULE = "3 to 48 characters: lowercase letters, numbers and hyphens.";
// Said while the address follows the name (createTenant derives it the same
// way, and adds -2, -3 … if it's taken).
const FOLLOWING_RULE = "Made from the name until you type here.";
const ADDRESS_INVALID = userFacingError("tenant.slug_invalid").message;
const NAME_MISSING = userFacingError("tenant.name_required").message;

type Field = "name" | "address";

// createTenant returns a code (src/lib/errors.ts). The ones about a field
// are placed on it; everything else goes under the form. The words are the
// catalog's either way.
const FIELD_OF: Partial<Record<ErrorCode, Field>> = {
  "tenant.name_required": "name",
  "tenant.slug_invalid": "address",
  "tenant.slug_taken": "address",
};

function placeError(code: ErrorCode): { field: Field | null; message: string } {
  return { field: FIELD_OF[code] ?? null, message: userFacingError(code).message };
}

type Props = {
  // The form action: useActionState's dispatcher in the app, a stand-in in
  // the design preview.
  action: (formData: FormData) => void;
  pending: boolean;
  // The last result's error code, as the action returned it.
  error?: ErrorCode;
  // Starting values. The app leaves them empty; the design preview fills
  // them to show each state.
  defaultName?: string;
  defaultAddress?: string;
};

// Presentational: whoever renders it owns the action and its result.
// Inputs are controlled, so they keep their values when React resets the
// form after an action that returned an error.
export function OrganizationForm({
  action,
  pending,
  error,
  defaultName = "",
  defaultAddress,
}: Props) {
  const id = useId();
  const ids = {
    name: `${id}-name`,
    nameError: `${id}-name-error`,
    address: `${id}-address`,
    addressHint: `${id}-address-hint`,
    addressError: `${id}-address-error`,
  };
  const nameRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const echoRef = useRef<HTMLSpanElement>(null);

  const [name, setName] = useState(defaultName);
  // The address follows the name until the user types in it
  // (src/lib/slug.ts, the helper createTenant derives it with).
  const [addressEdited, setAddressEdited] = useState(
    defaultAddress !== undefined && defaultAddress !== slugify(defaultName),
  );
  const [typedAddress, setTypedAddress] = useState(defaultAddress ?? "");
  const address = addressEdited ? typedAddress : slugify(name);

  // Fields changed since the last submit. An error about a value the user
  // has since changed no longer applies, so it's hidden.
  const [changed, setChanged] = useState<Record<Field, boolean>>({
    name: false,
    address: false,
  });

  // While a submit is running, the previous result is stale.
  const placed = error && !pending ? placeError(error) : null;
  const nameError = placed?.field === "name" && !changed.name ? placed.message : null;
  const addressError = placed?.field === "address" && !changed.address ? placed.message : null;
  const formError = placed && placed.field === null ? placed.message : null;

  // Native validation with plain messages. The attributes on the inputs
  // (required, pattern, maxLength) say the same thing and work before
  // hydration; pattern carries the length too. The address isn't required:
  // left empty, the server derives it. A derived address that's too short
  // (punctuation only, or another script) is refused here like a typed one.
  useEffect(() => {
    nameRef.current?.setCustomValidity(name.trim() ? "" : NAME_MISSING);
  }, [name]);
  useEffect(() => {
    addressRef.current?.setCustomValidity(SLUG_PATTERN.test(address) ? "" : ADDRESS_INVALID);
  }, [address]);

  // When a submit comes back with a field error, move focus to that field:
  // its error is part of its description, so a screen reader reads it out.
  // Focus that is already in the field (Enter pressed there) can't move to
  // it, and nothing would be read, so the error goes to the alert region
  // instead. Otherwise, if focus was lost while pending (the button is only
  // aria-disabled now, so it shouldn't be), put it back on the button,
  // ready for another try.
  const wasPending = useRef(pending);
  useEffect(() => {
    // An echoed error goes when its field is edited and the error hides.
    const echo = echoRef.current;
    if (echo?.textContent && echo.textContent !== nameError && echo.textContent !== addressError) {
      echo.textContent = "";
    }
    if (wasPending.current && !pending) {
      const field = nameError ? nameRef.current : addressError ? addressRef.current : null;
      if (field && field === document.activeElement) {
        if (echo) echo.textContent = nameError ?? addressError;
      } else if (field) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      } else if (!document.activeElement || document.activeElement === document.body) {
        submitRef.current?.focus();
      }
    }
    wasPending.current = pending;
  }, [pending, nameError, addressError]);

  // Until the address is typed in, it is made from the name.
  const following = !addressEdited;

  return (
    // The sign-in form's ruled register: one row per field, the label in
    // the left column, then the button's row. Whoever places the form closes
    // it with a rule (it may be the last thing in a fold). An error stands
    // under what it is about against a 2px ink rule; signal is kept for the
    // one primary action.
    <form
      action={action}
      onSubmit={(event) => {
        // The button stays focusable while pending (aria-disabled), so a
        // second click or Enter lands here and is dropped.
        if (pending) {
          event.preventDefault();
          return;
        }
        setChanged({ name: false, address: false });
        // Emptied first, so the same error after the next submit is a
        // change, and is read again.
        if (echoRef.current) echoRef.current.textContent = "";
      }}
    >
      <div className={formRowClass}>
        <label htmlFor={ids.name} className={formRowLabelClass}>
          Name
        </label>
        <div className="min-w-0">
          <input
            ref={nameRef}
            id={ids.name}
            name="name"
            autoComplete="organization"
            required
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setChanged((prev) => ({ name: true, address: prev.address || !addressEdited }));
            }}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? ids.nameError : undefined}
            className={inputClass}
          />
          {nameError && (
            <p id={ids.nameError} className={`mt-3 ${errorClass} ${errorInkRuleClass}`}>
              {nameError}
            </p>
          )}
        </div>
      </div>

      <div className={formRowClass}>
        <label htmlFor={ids.address} className={formRowLabelClass}>
          Web address
        </label>
        <div className="min-w-0">
          {/* The prefix shows the address as it will appear. Screen readers
              get it from the hint instead. */}
          <div className="flex max-w-sm items-start gap-2">
            <span aria-hidden="true" className="mt-1 flex h-10 shrink-0 items-center">
              /app/
            </span>
            <input
              ref={addressRef}
              id={ids.address}
              // Submitted only once typed in. While it follows the name the
              // server derives the same address and, if it's taken, adds
              // -2, -3 … instead of refusing it.
              name={addressEdited ? "slug" : undefined}
              maxLength={SLUG_MAX_LENGTH}
              pattern="[a-z0-9\-]{3,48}"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={address}
              onChange={(event) => {
                setAddressEdited(true);
                setTypedAddress(event.target.value);
                setChanged((prev) => ({ ...prev, address: true }));
              }}
              aria-invalid={addressError ? true : undefined}
              aria-describedby={
                addressError ? `${ids.addressError} ${ids.addressHint}` : ids.addressHint
              }
              className={`${inputClass} min-w-0`}
            />
          </div>
          <p id={ids.addressHint} className={`mt-2 ${hintClass}`}>
            <span className="sr-only">Your organization will be at /app/ followed by this. </span>
            {following && <>{FOLLOWING_RULE} </>}
            {ADDRESS_RULE}
          </p>
          {addressError && (
            <p id={ids.addressError} className={`mt-3 ${errorClass} ${errorInkRuleClass}`}>
              {addressError}
            </p>
          )}
        </div>
      </div>

      {/* The button's row: nothing in the label column, so the button lines
          up with the fields above it. */}
      <div className={formRowClass}>
        <div aria-hidden="true" className="hidden md:block" />
        <div className="min-w-0">
          {/* Always rendered, so a change inside them is announced, and side
              by side rather than nested: polite for progress, alert for an
              error (the echo of a field error, or one about the whole
              form). Empty, they take no space. */}
          <p aria-live="polite" className="sr-only">
            {pending ? "Creating the organization…" : ""}
          </p>
          <div role="alert">
            {/* Written by the effect above, never by React. */}
            <span ref={echoRef} className="sr-only" />
            {formError && <p className={`mb-4 ${errorClass} ${errorInkRuleClass}`}>{formError}</p>}
          </div>

          {/* While pending, the landing's dotted border and the words say it
              is working; nothing turns (DESIGN.md: no looping motion).
              aria-disabled rather than disabled, so focus stays on it. Its
              label is its own with the verb in -ing, as every pending
              button's is (Sign in, Signing in…); it grows to the right,
              where nothing sits. */}
          <button
            ref={submitRef}
            type="submit"
            aria-disabled={pending || undefined}
            className={submitButtonClass}
          >
            {pending ? "Creating organization…" : "Create organization"}
          </button>
        </div>
      </div>
    </form>
  );
}
