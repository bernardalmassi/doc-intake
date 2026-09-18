import { badgeClass, errorClass, hintClass, reviewBadgeClass, sectionTitleClass } from "@/app/ui";
import { EXTRACTION_LIMITS } from "@/lib/extraction/config";
import { DocumentActions, type ExtractMode } from "./document-actions";
import { ExtractionPanel, LatestRun } from "./extraction-panel";
import { fieldSummary } from "./fields";
import { fileKind, formatBytes, formatUtc } from "./format";
import { AlertIcon, ChevronRightIcon, DocumentsIcon, SpinnerIcon } from "./icons";
import { describeRunError, DOCUMENTS_HEADING_ID, runErrorAdvice, statusLabel } from "./messages";
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
  const { document, runs, fields, staleRun } = entry;
  const review = document.status === "needs_review";
  const hasFile = document.status !== "uploading";
  const kind = fileKind(document.mime_type);
  const meta = [
    kind,
    document.size_bytes !== null ? formatBytes(document.size_bytes) : null,
  ].filter((part): part is string => part !== null);

  // Extract is the primary action while there are no results yet; once
  // there are, running it again is secondary.
  let extract: { mode: ExtractMode; primary: boolean } | null = null;
  if (canManage && hasFile) {
    const mode: ExtractMode =
      document.status === "processing" && !staleRun ? "running" : runs.length > 0 ? "again" : "first";
    extract = { mode, primary: fields.length === 0 };
  }

  return (
    // Needs review is the one state in the accent: the border and the
    // badge, plus the badge's icon and words and its place at the top of
    // the list, so it never rests on color alone.
    <article
      aria-labelledby={`document-${document.id}`}
      className={`rounded-lg border bg-surface p-4 sm:p-5 ${review ? "border-accent" : "border-line"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 id={`document-${document.id}`} className="min-w-0 font-medium [overflow-wrap:anywhere]">
          {document.filename}
        </h3>
        <StatusBadge status={document.status} stale={staleRun} />
      </div>
      <p className={`mt-1 ${hintClass} tabular-nums`}>
        {meta.length > 0 && `${meta.join(" · ")} · `}
        {document.status === "uploading" ? "Upload started" : "Uploaded"}{" "}
        <time dateTime={document.created_at}>{formatUtc(document.created_at)}</time>
      </p>
      <StatusLine entry={entry} canManage={canManage} />
      <DocumentActions
        id={document.id}
        slug={slug}
        filename={document.filename}
        storagePath={document.storage_path}
        canDownload={hasFile}
        canDelete={canManage}
        extract={extract}
      />
      {fields.length > 0 && (
        // Open from the start when the document needs review: the fields
        // to check are the reason to be here.
        <details open={review} className="group mt-4 border-t border-line pt-3">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="text-muted group-open:rotate-90" />
            Extracted fields
          </summary>
          <ExtractionPanel fields={fields} />
        </details>
      )}
      {runs[0] && <LatestRun run={runs[0]} />}
    </article>
  );
}

function StatusBadge({ status, stale }: { status: string; stale: boolean }) {
  if (status === "needs_review") {
    return (
      <span className={`${reviewBadgeClass} shrink-0 gap-1`}>
        <AlertIcon />
        Needs review
      </span>
    );
  }
  if (status === "processing" && !stale) {
    return (
      <span className={`${badgeClass} shrink-0 gap-1.5`}>
        <SpinnerIcon />
        Extracting
      </span>
    );
  }
  return <span className={`${badgeClass} shrink-0`}>{stale ? "Extraction stalled" : statusLabel(status)}</span>;
}

// One or two sentences under the document's name saying where it stands
// and what happens next, computed from the document and its runs.
function StatusLine({ entry, canManage }: { entry: DocumentEntry; canManage: boolean }) {
  const { document, runs, staleRun } = entry;
  const latest = runs[0];
  const latestFailed = latest?.status === "failed";
  const retry = canManage ? "You can try again." : "An admin can try again.";

  switch (document.status) {
    case "uploading":
      return <UnfinishedUpload canManage={canManage} />;

    case "pending":
      if (latestFailed) {
        return <FailedRun lead="The last extraction failed." error={latest.error} next={retry} />;
      }
      return (
        <p className={`mt-3 ${hintClass}`}>
          {canManage
            ? "Not extracted yet. Extract reads its type, sender, dates, amounts and more."
            : "Not extracted yet. An admin can extract it."}
        </p>
      );

    case "processing":
      if (staleRun) {
        return (
          <p className="mt-3 max-w-prose text-sm">
            This extraction has been running for more than {EXTRACTION_LIMITS.staleRunMinutes} minutes and has
            probably stopped.{" "}
            <span className="text-muted">
              {canManage ? "Extract again to restart it." : "An admin can restart it."}
            </span>
          </p>
        );
      }
      return (
        <p className={`mt-3 ${hintClass}`}>
          Extraction is running. Refresh the page in a minute to see the results.
        </p>
      );

    case "failed":
      return <FailedRun lead="Extraction failed." error={latestFailed ? latest.error : null} next={retry} />;

    case "extracted":
    case "needs_review":
      return (
        <>
          <FieldsLine entry={entry} />
          {latestFailed && (
            <FailedRun
              lead="The latest extraction failed."
              error={latest.error}
              next="The results below are from an earlier run."
            />
          )}
        </>
      );

    default:
      return null;
  }
}

// The status line of an extracted document, computed from its fields:
// "9 of 10 fields found. 2 need checking: Due date and Total amount."
// The fields to check are in the accent, as they are what review means.
function FieldsLine({ entry }: { entry: DocumentEntry }) {
  if (entry.fields.length === 0) return null;
  const summary = fieldSummary(entry.fields);
  return (
    <p className="mt-3 max-w-prose text-sm">
      {summary.found}
      {summary.check && <span className="font-medium text-accent"> {summary.check}</span>}
      {summary.note && <span className="text-muted"> {summary.note}</span>}
    </p>
  );
}

// A failed run: what failed and why in danger text, then what to do next.
function FailedRun({ lead, error, next }: { lead: string; error: string | null; next: string }) {
  const advice = runErrorAdvice(error);
  return (
    <p className="mt-3 flex max-w-prose items-start gap-1.5 text-sm">
      <AlertIcon className="mt-0.5 text-danger" />
      <span className="min-w-0">
        <span className={errorClass}>
          {lead} {error !== null && describeRunError(error)}
        </span>{" "}
        <span className="text-muted">{advice ?? next}</span>
      </span>
    </p>
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
