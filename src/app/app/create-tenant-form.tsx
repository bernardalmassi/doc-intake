"use client";

import { useActionState } from "react";
import { createTenant } from "./actions";

export function CreateTenantForm() {
  const [state, formAction, pending] = useActionState(createTenant, {});

  return (
    <form action={formAction}>
      <p>
        <label htmlFor="name">Organization name</label>
        <br />
        <input id="name" name="name" required />
      </p>
      <p>
        <label htmlFor="slug">Slug</label>
        <br />
        <input
          id="slug"
          name="slug"
          required
          minLength={3}
          maxLength={48}
          pattern="[a-z0-9\-]+"
          title="Lowercase letters, numbers and hyphens"
        />
      </p>
      <p aria-live="polite">
        {state.error && <span role="alert">{state.error}</span>}
      </p>
      <button type="submit" disabled={pending}>
        Create organization
      </button>
    </form>
  );
}
