import Link from "next/link";
import { linkClass, pageTitleClass, sectionTitleClass, textTargetClass } from "@/app/ui";
import { DocumentList } from "./document-list";
import { ChevronRightIcon } from "./icons";
import { canManage, DOCUMENTS_HEADING_ID, ROLE_LABELS, roleAbilities } from "./messages";
import type { DocumentEntry, Organization, Role } from "./types";
import { UploadForm, type UploadState } from "./upload-form";

// Everything inside <main> on /app/[slug]. Takes data only, so the design
// preview renders it from fixture rows. The role only decides what is
// rendered; the database decides what each role may do. uploadState starts
// the upload form in a given state, for /dev/states; the page leaves it out.
export function OrganizationView({
  organization,
  role,
  entries,
  uploadState,
}: {
  organization: Organization;
  role: Role;
  entries: DocumentEntry[];
  uploadState?: UploadState;
}) {
  const manage = canManage(role);

  return (
    <>
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
          <li>
            <Link href="/app" className={`${linkClass} ${textTargetClass} inline-block`}>
              Organizations
            </Link>
          </li>
          <li className="flex min-w-0 items-center gap-1.5">
            <ChevronRightIcon />
            <span aria-current="page" className="min-w-0 [overflow-wrap:anywhere]">
              {organization.name}
            </span>
          </li>
        </ol>
      </nav>

      <h1 className={`mt-3 ${pageTitleClass} [overflow-wrap:anywhere]`}>{organization.name}</h1>
      <p className="mt-2 max-w-prose text-muted">
        Your role: <span className="font-medium text-fg">{ROLE_LABELS[role]}</span>. {roleAbilities(role)}
      </p>

      <section aria-labelledby="upload-heading" className="mt-8">
        <h2 id="upload-heading" className={sectionTitleClass}>
          Upload a document
        </h2>
        <UploadForm tenantId={organization.id} canManage={manage} initialState={uploadState} />
      </section>

      <section aria-labelledby={DOCUMENTS_HEADING_ID} className="mt-10">
        <DocumentList entries={entries} slug={organization.slug} canManage={manage} />
      </section>
    </>
  );
}
