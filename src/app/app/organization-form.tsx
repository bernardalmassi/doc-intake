"use client";

import { useEffect, useId, useRef, useState } from "react";
import { buttonClass, errorClass, hintClass, inputClass, labelClass } from "@/app/ui";

// The web address rule: the same as SLUG_PATTERN in actions.ts and the
// tenants.slug check constraint. Native validation enforces it before
// submit; the server checks it again.
const ADDRESS_MAX = 48;
const ADDRESS_PATTERN = /^[a-z0-9-]{3,48}$/;
const ADDRESS_RULE = "3 to 48 characters: lowercase letters, numbers and hyphens.";
const ADDRESS_INVALID = `Use ${ADDRESS_RULE}`;
const NAME_MISSING = "Enter a name for the organization.";

// "Café Müller & Co" -> "cafe-muller-co". Accents are dropped rather than
// the whole letter, runs of hyphens collapse to one, and hyphens are
// trimmed from the ends, so the address never starts or ends with one.
function deriveAddress(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, ADDRESS_MAX)
    .replace(/-+$/, "");
}

type Field = "name" | "address";

// createTenant returns these exact strings (actions.ts). Each is placed on
// the field it is about and reworded for the page. Anything else is
// unexpected and may be a raw database or network message, so it gets a
// plain sentence instead.
function placeError(error: string): { field: Field | null; message: string } {
  if (error === "That slug is already taken.") {
    return { field: "address", message: "That address is taken. Try another." };
  }
  // The rule itself is the hint right above the error.
  if (error.startsWith("Slug must be")) {
    return { field: "address", message: "That address isn't valid." };
  }
  if (error === "Name is required.") return { field: "name", message: NAME_MISSING };
  return {
    field: null,
    message: "Something went wrong and the organization wasn't created. Try again.",
  };
}

type Props = {
  // The form action: useActionState's dispatcher in the app, a stand-in in
  // the design preview.
  action: (formData: FormData) => void;
  pending: boolean;
  // The last result's error, as the action returned it.
  error?: string;
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
  // The address follows the name until the user types in it.
  const [addressEdited, setAddressEdited] = useState(
    defaultAddress !== undefined && defaultAddress !== deriveAddress(defaultName),
  );
  const [typedAddress, setTypedAddress] = useState(defaultAddress ?? "");
  const address = addressEdited ? typedAddress : deriveAddress(name);

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
  // (required, pattern, minLength, maxLength) say the same thing and work
  // before hydration; pattern carries the length too, because minLength
  // only checks what the user typed, not the derived address.
  useEffect(() => {
    nameRef.current?.setCustomValidity(name.trim() ? "" : NAME_MISSING);
  }, [name]);
  useEffect(() => {
    addressRef.current?.setCustomValidity(ADDRESS_PATTERN.test(address) ? "" : ADDRESS_INVALID);
  }, [address]);

  // When a submit comes back with a field error, move focus to that field:
  // its error is part of its description, so a screen reader reads it out.
  // Focus that is already in the field (Enter pressed there) can't move to
  // it, and nothing would be read, so the error goes to the alert region
  // instead. Otherwise, disabling the submit button while pending dropped
  // focus if it was on the button, so put it back there, ready for another
  // try.
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

  return (
    <form
      action={action}
      onSubmit={() => {
        setChanged({ name: false, address: false });
        // Emptied first, so the same error after the next submit is a
        // change, and is read again.
        if (echoRef.current) echoRef.current.textContent = "";
      }}
    >
      <div>
        <label htmlFor={ids.name} className={labelClass}>
          Organization name
        </label>
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
          <p id={ids.nameError} className={`mt-1 ${errorClass}`}>
            {nameError}
          </p>
        )}
      </div>

      <div className="mt-4">
        <label htmlFor={ids.address} className={labelClass}>
          Web address
        </label>
        {/* The prefix shows the address as it will appear. Screen readers
            get it from the hint instead. */}
        <div className="flex max-w-sm items-end gap-1.5">
          <span aria-hidden="true" className="flex h-9 shrink-0 items-center text-muted">
            /app/
          </span>
          <input
            ref={addressRef}
            id={ids.address}
            name="slug"
            required
            minLength={3}
            maxLength={ADDRESS_MAX}
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
        <p id={ids.addressHint} className={`mt-1 ${hintClass}`}>
          <span className="sr-only">Your organization will be at /app/ followed by this. </span>
          {ADDRESS_RULE}
        </p>
        {addressError && (
          <p id={ids.addressError} className={`mt-1 ${errorClass}`}>
            {addressError}
          </p>
        )}
      </div>

      {/* min-w keeps the button the same width when its label swaps. */}
      <div className="mt-6">
        <button
          ref={submitRef}
          type="submit"
          disabled={pending}
          className={`${buttonClass} min-w-37`}
        >
          {pending ? (
            <>
              <Spinner />
              Creating…
            </>
          ) : (
            "Create organization"
          )}
        </button>
      </div>

      {/* Always rendered, so a change inside them is announced, and side by
          side rather than nested: polite for progress, alert for an error
          (the echo of a field error, or one about the whole form). Empty,
          they take no space. */}
      <p aria-live="polite" className="sr-only">
        {pending ? "Creating the organization…" : ""}
      </p>
      <div role="alert" className="text-sm">
        {/* Written by the effect above, never by React. */}
        <span ref={echoRef} className="sr-only" />
        {formError && <p className={`mt-3 ${errorClass}`}>{formError}</p>}
      </div>
    </form>
  );
}

// Static under prefers-reduced-motion; the label still says what's
// happening.
function Spinner() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      className="motion-safe:animate-spin"
    >
      <path d="M8 2a6 6 0 1 1-6 6" />
    </svg>
  );
}
