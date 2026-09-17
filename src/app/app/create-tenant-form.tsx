"use client";

import { useActionState } from "react";
import { buttonClass, errorClass, inputClass, labelClass } from "@/app/ui";
import { createTenant } from "./actions";

export function CreateTenantForm() {
  const [state, formAction, pending] = useActionState(createTenant, {});

  return (
    <form action={formAction} className="mt-6 space-y-4">
      <div>
        <label htmlFor="name" className={labelClass}>
          Organization name
        </label>
        <input id="name" name="name" required className={inputClass} />
      </div>
      <div>
        <label htmlFor="slug" className={labelClass}>
          Slug
        </label>
        <input
          id="slug"
          name="slug"
          required
          minLength={3}
          maxLength={48}
          pattern="[a-z0-9\-]+"
          title="Lowercase letters, numbers and hyphens"
          className={inputClass}
        />
      </div>
      <p aria-live="polite" className="min-h-5 text-sm">
        {state.error && (
          <span role="alert" className={errorClass}>
            {state.error}
          </span>
        )}
      </p>
      <button type="submit" disabled={pending} className={buttonClass}>
        Create organization
      </button>
    </form>
  );
}
