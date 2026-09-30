// Every screen /dev/states can show, by id. Each renders what its real
// route renders (the same header, <main> and widths) from the static rows
// in fixtures.ts, with stand-ins for anything that would call a Server
// Action or Supabase. Ids are stable: capture plans in .design-work/plans
// refer to them.

import type { Role } from "@/app/app/[slug]/types";
import { OrganizationView } from "@/app/app/[slug]/organization-view";
import type { UploadState } from "@/app/app/[slug]/upload-form";
import { type Organization, OrganizationsView } from "@/app/app/organizations";
import { PreviewPending } from "@/app/components/pending";
import { MAIN_ID, SiteHeader } from "@/app/components/site-header";
import type { FormState } from "@/app/form-state";
import NotFound from "@/app/not-found";
import { SignInView } from "@/app/sign-in/sign-in-view";
import { SignUpView } from "@/app/sign-up/sign-up-view";
import { pageClass } from "@/app/ui";
import type { ErrorCode } from "@/lib/errors";
import {
  FixtureAccount,
  FixtureCheckEmail,
  FixtureCredentials,
  FixtureError,
  FixtureOrganizationForm,
} from "./fixture-forms";
import { FixtureOperations, type Outcome } from "./fixture-operations";
import {
  ALL_IDS,
  DONE_ID,
  EMAIL,
  entriesFor,
  FAILED_ID,
  FAILURE_IDS,
  longOrganization,
  NEEDS_REVIEW_ID,
  organization,
  organizations,
  READY_ID,
  RUNNING_ID,
  SIX_STATE_IDS,
  STALE_ID,
  UNFINISHED_ID,
  UPLOADING_ID,
} from "./fixtures";

export type Screen = {
  id: string;
  group: string;
  // what the screen shows, and, for a state reached by a click, what the
  // capture plan must do
  title: string;
  render: () => React.ReactNode;
};

// ---------------------------------------------------------------- shells

// The shell /app and /app/[slug] render: the header with the account, and
// <main>. page.tsx builds it inline; this is the same markup.
function SignedIn({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader>
        <FixtureAccount email={EMAIL} />
      </SiteHeader>
      <main id={MAIN_ID} className={pageClass}>
        {children}
      </main>
    </>
  );
}

function OrgPage({
  role = "owner",
  ids,
  uploadState,
  extract,
  remove,
  download,
}: {
  role?: Role;
  ids: string[];
  uploadState?: UploadState;
  extract?: Outcome;
  remove?: Outcome;
  download?: ErrorCode | null;
}) {
  return (
    <SignedIn>
      <FixtureOperations extract={extract} remove={remove} download={download}>
        <OrganizationView organization={organization} role={role} entries={entriesFor(ids)} uploadState={uploadState} />
      </FixtureOperations>
    </SignedIn>
  );
}

function OrgsPage({ list, form }: { list: Organization[]; form?: React.ReactNode }) {
  return (
    <SignedIn>
      <OrganizationsView organizations={list} createForm={form ?? <FixtureOrganizationForm />} />
    </SignedIn>
  );
}

function signIn(state: FormState = {}, pending = false, confirmError: ErrorCode | null = null) {
  return function SignInScreen() {
    return (
      <SignInView confirmError={confirmError} form={<FixtureCredentials mode="sign-in" state={state} pending={pending} />} />
    );
  };
}

function signUp(state: FormState = {}, pending = false) {
  return function SignUpScreen() {
    return <SignUpView form={<FixtureCredentials mode="sign-up" state={state} pending={pending} />} />;
  };
}

// ---------------------------------------------------------------- upload

const PDF = { name: "invoice-northgate-4502.pdf", type: "application/pdf", size: 1_254_400 };
const LONG = {
  name: "site-photos-calder-wharf-phase-3-snagging-list-with-annotations-and-signed-handover-sheet.pdf",
  type: "application/pdf",
  size: 6_912_000,
};

const UPLOAD_STATES: [id: string, title: string, state: UploadState, role?: Role][] = [
  ["org-upload-chosen", "Upload: a file chosen", { kind: "chosen", file: PDF }],
  ["org-upload-chosen-long-name", "Upload: a file with a long name chosen", { kind: "chosen", file: LONG }],
  ["org-upload-step-1", "Upload: step 1 of 3, preparing", { kind: "uploading", file: PDF, step: 1 }],
  ["org-upload-step-2", "Upload: step 2 of 3, sending the file", { kind: "uploading", file: PDF, step: 2 }],
  ["org-upload-step-3", "Upload: step 3 of 3, checking it arrived", { kind: "uploading", file: PDF, step: 3 }],
  ["org-upload-done", "Upload: finished, the picker again with a confirmation", { kind: "idle", uploaded: PDF.name }],
  [
    "org-upload-rejected-type",
    "Upload refused in the browser: not a PDF, PNG or JPEG",
    {
      kind: "rejected",
      reason: "type",
      file: { name: "meeting-notes.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 48_000 },
    },
  ],
  [
    "org-upload-rejected-size",
    "Upload refused in the browser: over 10 MB",
    { kind: "rejected", reason: "size", file: { name: "scan-full-colour.pdf", type: "application/pdf", size: 14_900_000 } },
  ],
  [
    "org-upload-rejected-empty",
    "Upload refused in the browser: an empty file",
    { kind: "rejected", reason: "empty", file: { name: "blank.pdf", type: "application/pdf", size: 0 } },
  ],
  ["org-upload-rejected-several", "Upload refused in the browser: several files dropped", { kind: "rejected", reason: "several", file: null }],
  [
    "org-upload-rejected-pages",
    "Upload refused in the browser: over 100 pages",
    { kind: "rejected", reason: "pages", file: { name: "annual-report-2025.pdf", type: "application/pdf", size: 8_400_000, pages: 212 } },
  ],
  [
    "org-upload-rejected-unreadable",
    "Upload refused in the browser: pages can't be counted",
    { kind: "rejected", reason: "unreadable", file: { name: "locked.pdf", type: "application/pdf", size: 310_000, pages: null } },
  ],
  [
    "org-upload-failed-step-1",
    "Upload failed at step 1: not allowed, no entry created",
    { kind: "failed", file: PDF, failure: { step: 1, code: "upload.not_allowed", rowCreated: false } },
  ],
  [
    "org-upload-failed-step-2",
    "Upload failed at step 2: connection dropped, an unfinished entry left",
    { kind: "failed", file: PDF, failure: { step: 2, code: "network.unavailable", rowCreated: true } },
  ],
  [
    "org-upload-failed-step-2-member",
    "Upload failed at step 2, member: too large, an unfinished entry left",
    { kind: "failed", file: PDF, failure: { step: 2, code: "upload.file_too_large", rowCreated: true } },
    "member",
  ],
  [
    "org-upload-failed-step-3",
    "Upload failed at step 3: the file didn't arrive",
    { kind: "failed", file: LONG, failure: { step: 3, code: "upload.file_missing", rowCreated: true } },
  ],
];

// ----------------------------------------------------- create organization

type CreateForm = { pending?: boolean; error?: ErrorCode; defaultName?: string; defaultAddress?: string };

// Every state of the create form, on the page a first organization is
// created from. Each error createTenant can return: the three about a field,
// and every form-level one classifyDatabaseError gives create_tenant.
const CREATE_STATES: [id: string, title: string, form: CreateForm][] = [
  ["org-create-suggestion", "A name typed: the address is made from it", { defaultName: "Bramhall Interiors" }],
  [
    "org-create-address-typed",
    "An address typed in: it no longer follows the name",
    { defaultName: "Bramhall Interiors", defaultAddress: "bramhall" },
  ],
  ["org-create-pending", "Submitting", { pending: true, defaultName: "Bramhall Interiors" }],
  ["org-create-error-name", "Name missing", { error: "tenant.name_required" }],
  [
    "org-create-error-slug-taken",
    "Web address taken",
    { error: "tenant.slug_taken", defaultName: "Bramhall Interiors", defaultAddress: "bramhall" },
  ],
  [
    "org-create-error-slug-invalid",
    "Web address invalid (typed)",
    { error: "tenant.slug_invalid", defaultName: "Bramhall", defaultAddress: "BI" },
  ],
  [
    "org-create-error-slug-derived-invalid",
    "Web address invalid: a name that makes too short an address",
    { error: "tenant.slug_invalid", defaultName: "Ω" },
  ],
  [
    "org-create-error-network",
    "The server couldn't be reached (a form-level error)",
    { error: "network.unavailable", defaultName: "Bramhall Interiors" },
  ],
  ["org-create-error-service", "The service is down", { error: "service.unavailable", defaultName: "Bramhall Interiors" }],
  ["org-create-error-signed-out", "Not signed in", { error: "auth.not_signed_in", defaultName: "Bramhall Interiors" }],
  ["org-create-error-session", "The session expired", { error: "auth.session_expired", defaultName: "Bramhall Interiors" }],
  ["org-create-error-input", "A value the database refused", { error: "input.invalid", defaultName: "Bramhall Interiors" }],
  ["org-create-error-unknown", "Anything unanticipated", { error: "unknown", defaultName: "Bramhall Interiors" }],
];

// ---------------------------------------------------------------- screens

export const SCREENS: Screen[] = [
  // Sign in
  { id: "sign-in", group: "Sign in", title: "Sign in, idle", render: signIn() },
  { id: "sign-in-pending", group: "Sign in", title: "Sign in, submitting", render: signIn({}, true) },
  {
    id: "sign-in-error-credentials",
    group: "Sign in",
    title: "Wrong email or password (a form-level error)",
    render: signIn({ error: "auth.invalid_credentials" }),
  },
  {
    id: "sign-in-error-unconfirmed",
    group: "Sign in",
    title: "Email not confirmed yet",
    render: signIn({ error: "auth.email_not_confirmed" }),
  },
  { id: "sign-in-error-rate-limited", group: "Sign in", title: "Too many attempts", render: signIn({ error: "auth.rate_limited" }) },
  {
    id: "sign-in-error-network",
    group: "Sign in",
    title: "The server couldn't be reached",
    render: signIn({ error: "network.unavailable" }),
  },
  {
    id: "sign-in-error-email-invalid",
    group: "Sign in",
    title: "The server refused the address (an error on the email field)",
    render: signIn({ error: "auth.email_invalid" }),
  },
  {
    id: "sign-in-error-required",
    group: "Sign in",
    title: "The server found a field empty (the browser's check was skipped)",
    render: signIn({ error: "auth.credentials_required" }),
  },
  {
    id: "sign-in-error-service",
    group: "Sign in",
    title: "The auth service answered that it is unavailable",
    render: signIn({ error: "service.unavailable" }),
  },
  {
    id: "sign-in-error-disabled",
    group: "Sign in",
    title: "Email sign-in turned off",
    render: signIn({ error: "auth.sign_in_disabled" }),
  },
  {
    id: "sign-in-error-suspended",
    group: "Sign in",
    title: "The account is suspended",
    render: signIn({ error: "auth.account_suspended" }),
  },
  {
    id: "sign-in-error-unknown",
    group: "Sign in",
    title: "Anything nobody anticipated",
    render: signIn({ error: "unknown" }),
  },
  {
    id: "sign-in-confirm-link",
    group: "Sign in",
    title: "Arrived from a confirmation link that didn't work",
    render: signIn({}, false, "auth.confirmation_link_invalid"),
  },
  {
    id: "sign-in-confirm-link-rate-limited",
    group: "Sign in",
    title: "Confirmation link refused: too many attempts",
    render: signIn({}, false, "auth.rate_limited"),
  },
  {
    id: "sign-in-confirm-link-network",
    group: "Sign in",
    title: "Confirmation link: the server couldn't reach Supabase",
    render: signIn({}, false, "network.unavailable"),
  },
  {
    id: "sign-in-confirm-link-service",
    group: "Sign in",
    title: "Confirmation link: the auth service is unavailable",
    render: signIn({}, false, "service.unavailable"),
  },
  {
    id: "sign-in-confirm-link-and-error",
    group: "Sign in",
    title: "The confirmation notice, then a wrong password on the form below it",
    render: signIn({ error: "auth.invalid_credentials" }, false, "auth.confirmation_link_invalid"),
  },

  // Sign up
  { id: "sign-up", group: "Sign up", title: "Sign up, idle", render: signUp() },
  { id: "sign-up-pending", group: "Sign up", title: "Sign up, submitting", render: signUp({}, true) },
  { id: "sign-up-email-taken", group: "Sign up", title: "Email already has an account", render: signUp({ error: "auth.email_taken" }) },
  { id: "sign-up-weak-password", group: "Sign up", title: "Password too weak", render: signUp({ error: "auth.password_weak" }) },
  {
    id: "sign-up-password-characters",
    group: "Sign up",
    title: "Password missing required characters",
    render: signUp({ error: "auth.password_missing_characters" }),
  },
  {
    id: "sign-up-password-breached",
    group: "Sign up",
    title: "Password found in a breach",
    render: signUp({ error: "auth.password_breached" }),
  },
  {
    id: "sign-up-password-short",
    group: "Sign up",
    title: "Password under the minimum, refused by the server",
    render: signUp({ error: "auth.password_too_short" }),
  },
  {
    id: "sign-up-password-long",
    group: "Sign up",
    title: "Password over 72 bytes, refused by the server",
    render: signUp({ error: "auth.password_too_long" }),
  },
  {
    id: "sign-up-email-invalid",
    group: "Sign up",
    title: "The server refused the address",
    render: signUp({ error: "auth.email_invalid" }),
  },
  {
    id: "sign-up-email-not-allowed",
    group: "Sign up",
    title: "An address the project can't send to",
    render: signUp({ error: "auth.email_not_allowed" }),
  },
  {
    id: "sign-up-email-rate-limited",
    group: "Sign up",
    title: "No more confirmation emails for now (a form-level error)",
    render: signUp({ error: "auth.email_rate_limited" }),
  },
  {
    id: "sign-up-rate-limited",
    group: "Sign up",
    title: "Too many attempts",
    render: signUp({ error: "auth.rate_limited" }),
  },
  {
    id: "sign-up-error-network",
    group: "Sign up",
    title: "The server couldn't be reached",
    render: signUp({ error: "network.unavailable" }),
  },
  {
    id: "sign-up-disabled",
    group: "Sign up",
    title: "Sign-ups turned off (a form-level error)",
    render: signUp({ error: "auth.signup_disabled" }),
  },
  {
    id: "check-email",
    group: "Sign up",
    title: "Check your email, after a sign-up that needs confirming",
    render: signUp({ message: "Check your email and open the confirmation link to finish signing up." }),
  },
  {
    id: "check-email-address",
    group: "Sign up",
    title: "Check your email, with the address that was typed",
    render: () => <SignUpView form={<FixtureCheckEmail email={EMAIL} />} />,
  },

  // Organizations
  { id: "orgs-none", group: "Organizations", title: "No organizations yet: the create form is open", render: () => <OrgsPage list={[]} /> },
  { id: "orgs-one", group: "Organizations", title: "One organization, owner", render: () => <OrgsPage list={organizations.slice(0, 1)} /> },
  {
    id: "orgs-several",
    group: "Organizations",
    title: "Three organizations, one per role (the plan clicks the summary to open the create form)",
    render: () => <OrgsPage list={organizations} />,
  },
  {
    id: "orgs-long",
    group: "Organizations",
    title: "Four organizations, one with the longest name and address",
    render: () => <OrgsPage list={[...organizations, longOrganization]} />,
  },
  {
    id: "orgs-opening",
    group: "Organizations",
    title: "Four organizations, the longest one clicked: its page hasn't arrived yet",
    render: () => (
      <PreviewPending target={`/app/${longOrganization.slug}`}>
        <OrgsPage list={[...organizations, longOrganization]} />
      </PreviewPending>
    ),
  },
  ...CREATE_STATES.map(([id, title, form]) => ({
    id,
    group: "Create organization",
    title,
    render: () => <OrgsPage list={[]} form={<FixtureOrganizationForm {...form} />} />,
  })),
  {
    id: "org-create-error-slug-taken-several",
    group: "Create organization",
    title: "Web address taken, with organizations listed (the plan clicks the summary to open the form)",
    render: () => (
      <OrgsPage
        list={organizations}
        form={<FixtureOrganizationForm error="tenant.slug_taken" defaultName="Bramhall Interiors" defaultAddress="bramhall-interiors" />}
      />
    ),
  },

  // The organization page: the six states the directions are judged on
  {
    id: "org-six-states",
    group: "Organization page",
    title: "Owner, six documents, one per state (ready, queued, running, done, needs review, failed), on arrival",
    render: () => <OrgPage ids={SIX_STATE_IDS} />,
  },
  {
    id: "org-needs-review",
    group: "Organization page",
    title: "The same six documents; the plan opens the needs-review document's fields ([data-open=fields])",
    render: () => <OrgPage ids={SIX_STATE_IDS} />,
  },
  {
    id: "org-run-history",
    group: "Organization page",
    title: "The same six documents; the plan opens the done document's run history ([data-open=runs])",
    render: () => <OrgPage ids={SIX_STATE_IDS} />,
  },
  {
    id: "org-member",
    group: "Organization page",
    title: "Member, the same six documents",
    render: () => <OrgPage role="member" ids={SIX_STATE_IDS} />,
  },
  {
    id: "org-leaving",
    group: "Organization page",
    title: "The breadcrumb's Organizations clicked: the list hasn't arrived yet",
    render: () => (
      <PreviewPending target="/app">
        <OrgPage ids={SIX_STATE_IDS} />
      </PreviewPending>
    ),
  },
  {
    id: "signing-out",
    group: "Header",
    title: "Sign out clicked: the action hasn't answered yet",
    render: () => (
      <PreviewPending target="sign-out">
        <OrgPage ids={SIX_STATE_IDS} />
      </PreviewPending>
    ),
  },
  { id: "org-empty", group: "Organization page", title: "Owner, no documents yet", render: () => <OrgPage ids={[]} /> },
  { id: "org-empty-member", group: "Organization page", title: "Member, no documents yet", render: () => <OrgPage role="member" ids={[]} /> },

  // The organization page: every document status today's code shows
  {
    id: "org-documents",
    group: "Organization page",
    title: "Owner, every document status: needs review, extracted, pending, processing, stalled, uploading, unfinished upload, failed",
    render: () => <OrgPage ids={ALL_IDS} />,
  },
  {
    id: "org-admin-documents",
    group: "Organization page",
    title: "Admin, every document status",
    render: () => <OrgPage role="admin" ids={ALL_IDS} />,
  },
  {
    id: "org-member-documents",
    group: "Organization page",
    title: "Member, every document status",
    render: () => <OrgPage role="member" ids={ALL_IDS} />,
  },
  {
    id: "org-doc-needs-review",
    group: "Document",
    title: "The needs-review document alone (Fig. 1's invoice), fields open",
    render: () => <OrgPage ids={[NEEDS_REVIEW_ID]} />,
  },
  {
    id: "org-doc-done",
    group: "Document",
    title: "The done document alone; the plan opens fields and run history",
    render: () => <OrgPage ids={[DONE_ID]} />,
  },
  {
    id: "org-doc-failed",
    group: "Document",
    title: "The failed document alone (no usable answer, an abandoned run before it); the plan opens run history",
    render: () => <OrgPage ids={[FAILED_ID]} />,
  },
  { id: "org-doc-running", group: "Document", title: "Running, 40 seconds in", render: () => <OrgPage ids={[RUNNING_ID]} /> },
  { id: "org-doc-stale", group: "Document", title: "Running for 25 minutes: stalled", render: () => <OrgPage ids={[STALE_ID]} /> },
  { id: "org-doc-uploading", group: "Document", title: "An upload 2 minutes in, seen from another page", render: () => <OrgPage ids={[UPLOADING_ID]} /> },
  { id: "org-doc-unfinished", group: "Document", title: "An upload that never finished (its row is over 10 minutes old)", render: () => <OrgPage ids={[UNFINISHED_ID]} /> },
  {
    id: "org-failures",
    group: "Document",
    title: "Owner, one failed document per way a run can fail, each with the exit its sentence calls for",
    render: () => <OrgPage ids={FAILURE_IDS} />,
  },
  {
    id: "org-failures-member",
    group: "Document",
    title: "Member, the same failed documents",
    render: () => <OrgPage role="member" ids={FAILURE_IDS} />,
  },

  // Document actions: states reached by a click ([data-action=...])
  {
    id: "org-extract-running",
    group: "Document actions",
    title: "Click Extract ([data-action=extract]): the action never answers",
    render: () => <OrgPage ids={[READY_ID]} extract="hang" />,
  },
  {
    id: "org-extract-finished",
    group: "Document actions",
    title: "Click Extract: queued, as the real action answers (the static rows don't change, so the line reads ready again)",
    render: () => <OrgPage ids={[READY_ID]} extract={{}} />,
  },
  {
    id: "org-extract-refused-budget",
    group: "Document actions",
    title: "Click Extract: the organization's monthly budget is used",
    render: () => <OrgPage ids={[READY_ID]} extract={{ error: "extraction.tenant_budget_reached" }} />,
  },
  {
    id: "org-extract-refused-rate",
    group: "Document actions",
    title: "Click Extract: the hourly limit is reached",
    render: () => <OrgPage ids={[READY_ID]} extract={{ error: "extraction.rate_limited" }} />,
  },
  {
    id: "org-extract-refused-global",
    group: "Document actions",
    title: "Click Extract: the overall monthly budget is used, for everyone",
    render: () => <OrgPage ids={[READY_ID]} extract={{ error: "extraction.global_budget_reached" }} />,
  },
  {
    id: "org-extract-already-running",
    group: "Document actions",
    title: "Click Extract: another extraction of it is already running",
    render: () => <OrgPage ids={[READY_ID]} extract={{ error: "extraction.already_running" }} />,
  },
  {
    id: "org-extract-again-running",
    group: "Document actions",
    title: "Click Extract again on the failed document ([data-action=extract]): the action never answers",
    render: () => <OrgPage ids={[FAILED_ID]} extract="hang" />,
  },
  {
    id: "org-extract-again-finished",
    group: "Document actions",
    title: "Click Extract again in the done document's runs row (open the line, then the second [data-action=extract]): queued",
    render: () => <OrgPage ids={[DONE_ID]} />,
  },
  {
    id: "org-extract-network",
    group: "Document actions",
    title: "Click Extract: the request never came back",
    render: () => <OrgPage ids={[READY_ID]} extract="throw" />,
  },
  {
    id: "org-delete-confirm",
    group: "Document actions",
    title: "Click Delete ([data-action=delete]) once: armed, asking to confirm",
    render: () => <OrgPage ids={[READY_ID]} />,
  },
  {
    id: "org-delete-error",
    group: "Document actions",
    title: "Click Delete, wait 600 ms, click again: the file couldn't be removed",
    render: () => <OrgPage ids={[READY_ID]} remove={{ error: "document.file_still_present" }} />,
  },
  {
    id: "org-deleting",
    group: "Document actions",
    title: "Click Delete, wait 600 ms, click again: the action never answers",
    render: () => <OrgPage ids={[READY_ID]} remove="hang" />,
  },
  {
    id: "org-delete-confirm-open",
    group: "Document actions",
    title: "The needs-review document open; click its File row's Delete once: armed",
    render: () => <OrgPage ids={[NEEDS_REVIEW_ID]} />,
  },
  {
    id: "org-download-error",
    group: "Document actions",
    title: "Click Download ([data-action=download]): the file isn't available",
    render: () => <OrgPage ids={[READY_ID]} download="download.not_found" />,
  },

  // Upload
  {
    id: "org-upload-idle",
    group: "Upload",
    title: "Upload: nothing chosen yet",
    render: () => <OrgPage ids={[READY_ID]} />,
  },
  {
    id: "org-upload-drag-over",
    group: "Upload",
    title: "Upload: a file dragged over the line (the plan dispatches dragenter with a file on [data-upload])",
    render: () => <OrgPage ids={[READY_ID]} />,
  },
  ...UPLOAD_STATES.map(([id, title, state, role]) => ({
    id,
    group: "Upload",
    title,
    // The unfinished entry a failed upload leaves behind is in the list
    // only when the failure says one was created.
    render: () => (
      <OrgPage
        role={role}
        ids={state.kind === "failed" && state.failure.rowCreated ? [UNFINISHED_ID, READY_ID] : [READY_ID]}
        uploadState={state}
      />
    ),
  })),

  // Errors
  { id: "error-page", group: "Errors", title: "A page that failed to render, with its reference", render: () => <FixtureError digest="2841937645" /> },
  {
    id: "error-page-no-reference",
    group: "Errors",
    title: "A page that failed in the browser: no reference (a server error always has one in production)",
    render: () => <FixtureError />,
  },
  { id: "not-found", group: "Errors", title: "Not found, or no access", render: () => <NotFound /> },
];
