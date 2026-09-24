// Every screen /dev/states can show, by id. Each renders what its real
// route renders (the same header, <main> and widths) from the static rows
// in fixtures.ts, with stand-ins for anything that would call a Server
// Action or Supabase. Ids are stable: capture plans in .design-work/plans
// refer to them.

import type { Role } from "@/app/app/[slug]/types";
import { OrganizationView } from "@/app/app/[slug]/organization-view";
import type { UploadState } from "@/app/app/[slug]/upload-form";
import { type Organization, OrganizationsView } from "@/app/app/organizations";
import { MAIN_ID, SiteHeader } from "@/app/components/site-header";
import type { FormState } from "@/app/form-state";
import NotFound from "@/app/not-found";
import { SignInView } from "@/app/sign-in/sign-in-view";
import { SignUpView } from "@/app/sign-up/sign-up-view";
import { pageClass } from "@/app/ui";
import type { ErrorCode } from "@/lib/errors";
import { FixtureAccount, FixtureCredentials, FixtureError, FixtureOrganizationForm } from "./fixture-forms";
import { FixtureOperations, type Outcome } from "./fixture-operations";
import {
  ALL_IDS,
  DONE_ID,
  EMAIL,
  entriesFor,
  FAILED_ID,
  NEEDS_REVIEW_ID,
  organization,
  organizations,
  READY_ID,
  RUNNING_ID,
  SIX_STATE_IDS,
  STALE_ID,
  UNFINISHED_ID,
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
    id: "sign-in-confirm-link",
    group: "Sign in",
    title: "Arrived from a confirmation link that didn't work",
    render: signIn({}, false, "auth.confirmation_link_invalid"),
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

  // Organizations
  { id: "orgs-none", group: "Organizations", title: "No organizations yet: create the first", render: () => <OrgsPage list={[]} /> },
  { id: "orgs-one", group: "Organizations", title: "One organization, owner", render: () => <OrgsPage list={organizations.slice(0, 1)} /> },
  {
    id: "orgs-several",
    group: "Organizations",
    title: "Three organizations, one per role (click summary to open the create form)",
    render: () => <OrgsPage list={organizations} />,
  },
  {
    id: "org-create-pending",
    group: "Organizations",
    title: "Create organization, submitting",
    render: () => <OrgsPage list={[]} form={<FixtureOrganizationForm pending defaultName="Bramhall Interiors" />} />,
  },
  {
    id: "org-create-error-name",
    group: "Organizations",
    title: "Create organization: name missing",
    render: () => <OrgsPage list={[]} form={<FixtureOrganizationForm error="tenant.name_required" />} />,
  },
  {
    id: "org-create-error-slug-taken",
    group: "Organizations",
    title: "Create organization: web address taken",
    render: () => (
      <OrgsPage
        list={[]}
        form={<FixtureOrganizationForm error="tenant.slug_taken" defaultName="Bramhall Interiors" defaultAddress="bramhall" />}
      />
    ),
  },
  {
    id: "org-create-error-slug-invalid",
    group: "Organizations",
    title: "Create organization: web address invalid",
    render: () => (
      <OrgsPage list={[]} form={<FixtureOrganizationForm error="tenant.slug_invalid" defaultName="Bramhall" defaultAddress="BI" />} />
    ),
  },
  {
    id: "org-create-error-network",
    group: "Organizations",
    title: "Create organization: the server couldn't be reached (a form-level error)",
    render: () => (
      <OrgsPage list={[]} form={<FixtureOrganizationForm error="network.unavailable" defaultName="Bramhall Interiors" />} />
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
  { id: "org-empty", group: "Organization page", title: "Owner, no documents yet", render: () => <OrgPage ids={[]} /> },
  { id: "org-empty-member", group: "Organization page", title: "Member, no documents yet", render: () => <OrgPage role="member" ids={[]} /> },

  // The organization page: every document status today's code shows
  {
    id: "org-documents",
    group: "Organization page",
    title: "Owner, every document status: needs review, extracted, pending, processing, stalled, failed, unfinished upload",
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
  { id: "org-doc-unfinished", group: "Document", title: "An upload that never finished", render: () => <OrgPage ids={[UNFINISHED_ID]} /> },

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
    title: "Click Extract: finished",
    render: () => <OrgPage ids={[READY_ID]} extract={{ message: "Extraction finished." }} />,
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
    id: "org-download-error",
    group: "Document actions",
    title: "Click Download ([data-action=download]): the file isn't available",
    render: () => <OrgPage ids={[READY_ID]} download="download.not_found" />,
  },

  // Upload
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
  { id: "not-found", group: "Errors", title: "Not found, or no access", render: () => <NotFound /> },
];
