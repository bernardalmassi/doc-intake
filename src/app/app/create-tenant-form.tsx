"use client";

import { useActionState } from "react";
import { createTenant } from "./actions";
import { OrganizationForm } from "./organization-form";

// Wires the create form to the createTenant Server Action, which reads
// `name` and `slug` and either returns { error } or redirects to the new
// organization. How the form looks and how errors render lives in
// organization-form.tsx.
export function CreateTenantForm() {
  const [state, formAction, pending] = useActionState(createTenant, {});
  return <OrganizationForm action={formAction} pending={pending} error={state.error} />;
}
