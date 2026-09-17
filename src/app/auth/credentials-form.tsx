"use client";

import { useActionState } from "react";
import type { FormState } from "./actions";

type Props = {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  passwordAutoComplete: "current-password" | "new-password";
};

export function CredentialsForm({ action, submitLabel, passwordAutoComplete }: Props) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction}>
      <p>
        <label htmlFor="email">Email</label>
        <br />
        <input id="email" name="email" type="email" autoComplete="email" required />
      </p>
      <p>
        <label htmlFor="password">Password</label>
        <br />
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={passwordAutoComplete}
          required
        />
      </p>
      <p aria-live="polite">
        {state.error && <span role="alert">{state.error}</span>}
        {state.message}
      </p>
      <button type="submit" disabled={pending}>
        {submitLabel}
      </button>
    </form>
  );
}
