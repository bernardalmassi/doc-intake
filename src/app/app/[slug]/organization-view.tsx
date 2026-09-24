import Link from "next/link";
import { linkClass, pageTitleClass } from "@/app/ui";
import { DocumentList } from "./document-list";
import { canManage, DOCUMENTS_HEADING_ID, roleAbilities } from "./messages";
import type { StatedEntry } from "./document-state";
import type { Organization, Role } from "./types";
import { UploadForm, type UploadState } from "./upload-form";

// Everything inside <main> on /app/[slug]. Takes data only, so the design
// preview renders it from fixture rows. The role only decides what is
// rendered; the database decides what each role may do. uploadState starts
// the upload form in a given state, for /dev/states; the page leaves it out.
//
// The title hangs from the left edge, as the landing's headline does; the
// sections below sit in the landing's grid, labels in the first three
// columns. Documents come first, because what needs a person is there;
// uploading, the rarer act, is last.
export function OrganizationView({
  organization,
  role,
  entries,
  uploadState,
}: {
  organization: Organization;
  role: Role;
  entries: StatedEntry[];
  uploadState?: UploadState;
}) {
  const manage = canManage(role);

  return (
    <>
      {/* The trail stops at the organizations list: the title under it is
          the page it leads to, so the name isn't printed twice. */}
      <nav aria-label="Breadcrumb">
        <ol className="label flex items-center gap-2 text-ink">
          <li className="flex items-center gap-2">
            {/* 24px tall: the label's 16px line plus 4px above and below,
                taken back by negative margins. */}
            <Link href="/app" className={`${linkClass} -my-1 inline-block py-1`}>
              Organizations
            </Link>
            <span aria-hidden="true">/</span>
          </li>
        </ol>
      </nav>

      <h1 className={`mt-3 ${pageTitleClass} [overflow-wrap:anywhere]`}>{organization.name}</h1>

      {/* What the reader's role lets them do, as a readout in the grid the
          sections below use, not the role's name: "Owner" says nothing on
          an organization of one. */}
      <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-1 lg:grid-cols-12">
        <dt className="label lg:col-span-3 lg:pt-1.5">You can</dt>
        <dd className="max-w-prose lg:col-span-8 lg:col-start-4">{roleAbilities(role)}</dd>
      </dl>

      <section aria-labelledby={DOCUMENTS_HEADING_ID} className="mt-10 md:mt-14">
        <DocumentList entries={entries} slug={organization.slug} canManage={manage} />
      </section>

      <section aria-labelledby="upload-heading" className="mt-14 grid grid-cols-1 gap-x-8 md:mt-20 lg:grid-cols-12">
        <h2 id="upload-heading" className="label lg:col-span-3">
          Upload
        </h2>
        <div className="mt-3 min-w-0 lg:col-span-8 lg:col-start-4 lg:mt-0">
          <UploadForm tenantId={organization.id} canManage={manage} initialState={uploadState} />
        </div>
      </section>
    </>
  );
}
