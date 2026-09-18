import { badgeClass, hintClass, panelClass, reviewBadgeClass, sectionTitleClass } from "@/app/ui";
import { DocumentActions } from "./document-actions";
import { ExtractionPanel } from "./extraction-panel";
import { fileKind, formatBytes, formatUtc } from "./format";
import { DocumentsIcon } from "./icons";
import { DOCUMENTS_HEADING_ID, statusLabel } from "./messages";
import type { DocumentEntry } from "./types";

type ListProps = {
  entries: DocumentEntry[];
  slug: string;
  canManage: boolean;
};

export function DocumentList({ entries, slug, canManage }: ListProps) {
  const reviewCount = entries.filter((e) => e.document.status === "needs_review").length;

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={DOCUMENTS_HEADING_ID} tabIndex={-1} className={sectionTitleClass}>
          Documents
        </h2>
        {entries.length > 0 && (
          <p className={`${hintClass} tabular-nums`}>
            {entries.length} {entries.length === 1 ? "document" : "documents"}
            {reviewCount > 0 && ` · ${reviewCount} ${reviewCount === 1 ? "needs" : "need"} review`}
          </p>
        )}
      </div>

      {entries.length === 0 ? (
        <EmptyDocuments canManage={canManage} />
      ) : (
        <ul className="mt-4 space-y-3">
          {entries.map((entry) => (
            <li key={entry.document.id}>
              <DocumentItem entry={entry} slug={slug} canManage={canManage} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// The first thing a new organization sees: what to do, in order.
function EmptyDocuments({ canManage }: { canManage: boolean }) {
  const steps = [
    <>
      <span className="font-medium">Upload</span> a PDF, PNG or JPEG of up to 10&nbsp;MB, using the box above.
    </>,
    canManage ? (
      <>
        <span className="font-medium">Extract</span> it: its type, sender, recipient, dates, reference number,
        total and a one-line summary are read for you.
      </>
    ) : (
      <>
        An admin <span className="font-medium">extracts</span> it: its type, sender, recipient, dates, reference
        number, total and a one-line summary are read for you.
      </>
    ),
    <>
      <span className="font-medium">Check</span> anything marked <span className={reviewBadgeClass}>Needs review</span>
      : those are the values the model wasn&apos;t sure about.
    </>,
  ];

  return (
    <div className="mt-4 rounded-lg border border-dashed border-line-strong p-5 sm:p-8">
      <DocumentsIcon className="text-muted" />
      <h3 className="mt-3 font-semibold">No documents yet</h3>
      <p className="mt-1 max-w-prose text-muted">
        Documents uploaded to this organization appear here, for every member to see.
      </p>
      <ol className="mt-5 max-w-prose space-y-3">
        {steps.map((step, index) => (
          <li key={index} className="flex gap-3">
            <span
              aria-hidden="true"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-sm tabular-nums text-muted"
            >
              {index + 1}
            </span>
            <span className="min-w-0">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function DocumentItem({ entry, slug, canManage }: { entry: DocumentEntry; slug: string; canManage: boolean }) {
  const { document, runs, fields } = entry;
  const review = document.status === "needs_review";
  const kind = fileKind(document.mime_type);
  const meta = [
    kind,
    document.size_bytes !== null ? formatBytes(document.size_bytes) : null,
  ].filter((part): part is string => part !== null);

  return (
    <article aria-labelledby={`document-${document.id}`} className={panelClass}>
      <div className="flex items-start justify-between gap-3">
        <h3 id={`document-${document.id}`} className="min-w-0 font-medium [overflow-wrap:anywhere]">
          {document.filename}
        </h3>
        <span className={review ? reviewBadgeClass : badgeClass}>{statusLabel(document.status)}</span>
      </div>
      <p className={`mt-1 ${hintClass} tabular-nums`}>
        {meta.length > 0 && `${meta.join(" · ")} · `}
        {document.status === "uploading" ? "Upload started" : "Uploaded"}{" "}
        <time dateTime={document.created_at}>{formatUtc(document.created_at)}</time>
      </p>
      {document.status === "uploading" && <UnfinishedUpload canManage={canManage} />}
      <div className="mt-3">
        <DocumentActions
          id={document.id}
          slug={slug}
          filename={document.filename}
          storagePath={document.storage_path}
          status={document.status}
          uploaded={document.status !== "uploading"}
          canDelete={canManage}
          canExtract={canManage}
        />
      </div>
      <ExtractionPanel run={runs[0] ?? null} fields={fields} />
    </article>
  );
}

// A row whose file never arrived: the upload was interrupted, or failed
// after the row was created. There is nothing to download or extract, and
// nothing sweeps these yet, so say what happened and who can tidy it up.
function UnfinishedUpload({ canManage }: { canManage: boolean }) {
  return (
    <p className="mt-3 max-w-prose text-sm">
      This upload never finished, so there is no file to download or extract. To add the document, upload it
      again.{" "}
      <span className="text-muted">
        {canManage ? "You can delete this entry." : "An admin can delete this entry."}
      </span>
    </p>
  );
}
