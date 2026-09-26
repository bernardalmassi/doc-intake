"use client";

// Client-side stand-ins for the parts of each screen that would otherwise
// call a Server Action. Each renders the real view with a fixed state and
// an action that does nothing.

import { AccountControlsView } from "@/app/components/site-header";
import { CheckEmail } from "@/app/auth/check-email";
import { CredentialsFormView, type Mode } from "@/app/auth/credentials-form";
import { OrganizationForm } from "@/app/app/organization-form";
import { ErrorView } from "@/app/error-view";
import type { FormState } from "@/app/form-state";
import type { ErrorCode } from "@/lib/errors";

const noop = () => {};

export function FixtureAccount({ email }: { email: string }) {
  return <AccountControlsView email={email} signOutAction={noop} />;
}

export function FixtureCredentials({
  mode,
  state = {},
  pending = false,
}: {
  mode: Mode;
  state?: FormState;
  pending?: boolean;
}) {
  return <CredentialsFormView mode={mode} state={state} pending={pending} formAction={noop} />;
}

// What the sign-up form shows once the action asks for confirmation, with
// the address the visitor typed (the form holds it in its own state, so
// the sign-up fixture above can only show the panel without one).
export function FixtureCheckEmail({ email }: { email: string }) {
  return <CheckEmail email={email} onStartAgain={noop} />;
}

export function FixtureOrganizationForm(props: {
  pending?: boolean;
  error?: ErrorCode;
  defaultName?: string;
  defaultAddress?: string;
}) {
  return <OrganizationForm {...props} action={noop} pending={props.pending ?? false} />;
}

export function FixtureError({ digest }: { digest?: string }) {
  return <ErrorView digest={digest} onRetry={noop} />;
}
