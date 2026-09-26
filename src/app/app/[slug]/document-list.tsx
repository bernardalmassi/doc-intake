import { errorInkRuleClass } from "@/app/ui";
import { EXTRACTION_LIMITS } from "@/lib/extraction/config";
import { userFacingError } from "@/lib/errors";
import { DocumentActions, type ExtractMode } from "./document-actions";
import { DOCUMENT_STATES, type DocumentState, failedExit, type StatedEntry, stateOf } from "./document-state";
import { ExtractionPanel } from "./extraction-panel";
import { extractReads, fieldSummary } from "./fields";
import { fileKind, formatBytes, formatClock, formatUtc } from "./format";
import { Elapsed, LedgerLine, RunsToggle } from "./ledger";
import { DOCUMENTS_HEADING_ID } from "./messages";
import { RunHistory, runHistoryMeta } from "./run-history";
import { STATE_GLYPHS, STATE_WORDS, StateGlyph, StateMark } from "./state-glyph";
import type { DocumentEntry } from "./types";

type ListProps = {
  entries: StatedEntry[];
  slug: string;
  canManage: boolean;
};

// The documents as a register: one ruled line per document, its state as
// a printed column (a glyph and a word), its name, one sentence saying
// what happens next, and at most one action. A line opens in place onto
// what it has: the fields (the ones to check first), the run history and
// the file. Lines that need review arrive open; nothing else does.
//
// From 64rem the landing's grid: the section's label and the register's
// key in the first three columns, the register in the next eight, the
// last empty. Each state is worked out once, here, and passed down.
export function DocumentList({ entries, slug, canManage }: ListProps) {
  const stated = entries.map((entry) => ({ entry, state: stateOf(entry) }));
  // What Extract reads is said once, beside the first Extract on the page.
  const firstReady = stated.find(({ entry, state }) => state === "ready" && entry.document.status !== "uploading");
  const counts = new Map<DocumentState, number>();
  for (const { state } of stated) counts.set(state, (counts.get(state) ?? 0) + 1);

  return (
    <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-12">
      <div className="lg:col-span-3">
        <h2 id={DOCUMENTS_HEADING_ID} tabIndex={-1} className="label">
          Documents · {entries.length}
        </h2>
        {entries.length > 0 && (
          // The register's key: every state's mark and word, and how many
          // lines are in it, zeros included. On a narrow screen there is no
          // margin for it, and the lines teach it. Needs review's square
          // is filled only when a line needs review: at 0 it is the same
          // square in outline, so the key still teaches the mark without
          // the page's one call for attention pointing at nothing.
          <ul aria-label="Documents by state" className="mt-4 hidden max-w-56 lg:block">
            {DOCUMENT_STATES.map((state) => {
              const count = counts.get(state) ?? 0;
              const glyph = state === "needs-review" && count === 0 ? "signal-outline" : STATE_GLYPHS[state];
              return (
                <li key={state} className="label flex h-7 items-center gap-2">
                  <StateGlyph glyph={glyph} />
                  <span className="flex-1">{STATE_WORDS[state]}</span>
                  <span>{count}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-3 min-w-0 lg:col-span-8 lg:col-start-4 lg:mt-0">
        {entries.length === 0 ? (
          <EmptyDocuments canManage={canManage} />
        ) : (
          <ul className="border-t border-ink">
            {stated.map(({ entry, state }) => (
              <li key={entry.document.id}>
                <DocumentLine
                  entry={entry}
                  state={state}
                  slug={slug}
                  canManage={canManage}
                  explainExtract={canManage && entry === firstReady?.entry}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// An empty register: one plain sentence, then the three things that fill
// it, as ruled lines in the same two columns.
function EmptyDocuments({ canManage }: { canManage: boolean }) {
  const steps: [string, React.ReactNode][] = [
    ["Upload", <>A PDF, PNG or JPEG of up to 10&nbsp;MB, in Upload below.</>],
    [
      "Extract",
      canManage ? extractReads() : `An admin extracts it. ${extractReads()}`,
    ],
    [
      "Check",
      <>
        Anything marked <StateMark state="needs-review" className="align-[-1px]" />: the values the model wasn&apos;t
        sure about, with the words it read them from.
      </>,
    ],
  ];

  return (
    <div className="border-t border-ink">
      <p className="py-4">No documents yet. Documents uploaded here are listed for every member to see.</p>
      <ol>
        {steps.map(([verb, text], index) => (
          <li key={verb} className="border-t border-ink py-3 md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-x-4">
            <span className="label block">
              {index + 1} {verb}
            </span>
            <span className="mt-1 block text-small md:mt-0">{text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// One document's line and what it opens onto.
function DocumentLine({
  entry,
  state,
  slug,
  canManage,
  explainExtract,
}: {
  entry: DocumentEntry;
  state: DocumentState;
  slug: string;
  canManage: boolean;
  explainExtract: boolean;
}) {
  const { document, runs, fields } = entry;
  const hasFile = document.status !== "uploading";
  const low = fields.filter((field) => field.band === "low").length;
  const nameId = `document-${document.id}`;
  const again: ExtractMode = runs.length > 0 ? "again" : "first";
  const hasFields = fields.length > 0;

  const actions = { id: document.id, slug, filename: document.filename, storagePath: document.storage_path };

  // The closed line's one exit: Extract for ready; for failed, what the
  // failure's own sentence tells the reader to do (failedExit). Needs
  // review and done open onto their fields, which is the line itself.
  // Uploading, queued and running offer nothing. Never the signal fill: on
  // this page signal marks what needs a person, not an action.
  const failed = state === "failed" ? failedExit(entry) : null;
  let exit: React.ReactNode = null;
  if (canManage && state === "ready" && hasFile) {
    exit = (
      <DocumentActions {...actions} canDownload={false} canDelete={false} extract={{ mode: again, primary: false }} />
    );
  } else if (canManage && failed === "extract") {
    exit = (
      <DocumentActions {...actions} canDownload={false} canDelete={false} extract={{ mode: "again", primary: false }} />
    );
  } else if (canManage && failed === "delete") {
    exit = <DocumentActions {...actions} canDownload={false} canDelete extract={null} />;
  } else if (failed === "download") {
    // "Review it yourself instead": the file is the way on, for any member.
    exit = <DocumentActions {...actions} canDownload canDelete={false} extract={null} />;
  }

  // What the exit already offers isn't offered again in the File row, and
  // Extract again stays in the runs row when the exit is something else,
  // so a failure that says retrying won't help never leaves a dead end.
  const deleteOnLine = canManage && failed === "delete";
  const downloadOnLine = failed === "download";
  const extractInRuns = canManage && hasFile && (hasFields || (failed !== null && failed !== "extract"));
  const latest = runs[0];

  return (
    <article
      aria-labelledby={nameId}
      data-doc-status={document.status}
      data-doc-state={state}
      className="border-b border-ink"
    >
      <LedgerLine
        defaultOpen={state === "needs-review"}
        revealsFields={hasFields}
        cue={hasFields ? "Fields" : undefined}
        head={
          <>
            <StateMark state={state} count={state === "needs-review" ? low : undefined} className="md:w-44 md:shrink-0" />
            <span
              id={nameId}
              title={document.filename}
              className="block w-full min-w-0 [overflow-wrap:anywhere] md:truncate"
            >
              {document.filename}
            </span>
          </>
        }
        detail={<Detail entry={entry} state={state} canManage={canManage} explainExtract={explainExtract} />}
        exit={exit}
      >
        {hasFields && latest?.status === "failed" && latest.error_code && (
          <p className={`mb-4 max-w-prose text-small md:ml-48 ${errorInkRuleClass}`}>
            The latest run failed. {userFacingError(latest.error_code).message} The fields below are from an earlier
            run.
          </p>
        )}

        {hasFields && <ExtractionPanel fields={fields} />}

        {runs.length > 0 ? (
          <RunsToggle
            summary={runHistoryMeta(runs)}
            action={
              extractInRuns ? (
                <DocumentActions
                  {...actions}
                  canDownload={false}
                  canDelete={false}
                  extract={{ mode: "again", primary: false }}
                />
              ) : undefined
            }
          >
            <RunHistory runs={runs} filename={document.filename} staleRun={entry.staleRun} />
          </RunsToggle>
        ) : (
          <p
            className={`${hasFields ? "mt-6" : ""} border-t border-ink pt-3 md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-x-4`}
          >
            <span className="label block">Runs 0</span>
            <span className="text-small">No runs yet.</span>
          </p>
        )}

        {/* An upload still arriving isn't deleted from under its sender:
            Delete comes back if it never finishes. */}
        <FileRow
          entry={entry}
          actions={actions}
          canDownload={hasFile && !downloadOnLine}
          canDelete={canManage && !deleteOnLine && state !== "uploading"}
        />
      </LedgerLine>
    </article>
  );
}

// The document as a file: its kind, size and upload time, and what can be
// done with the file itself.
function FileRow({
  entry,
  actions,
  canDownload,
  canDelete,
}: {
  entry: DocumentEntry;
  actions: { id: string; slug: string; filename: string; storagePath: string };
  canDownload: boolean;
  canDelete: boolean;
}) {
  const { document } = entry;
  const kind = fileKind(document.mime_type);
  const meta = [kind, document.size_bytes !== null ? formatBytes(document.size_bytes) : null].filter(
    (part): part is string => part !== null,
  );

  return (
    <div className="ledger-file mt-4 border-t border-ink pt-3 md:mt-6">
      <span className="ledger-file-label label">File</span>
      <p className="ledger-file-meta text-small">
        {meta.length > 0 && `${meta.join(" · ")} · `}
        {document.status === "uploading" ? "Upload started" : "Uploaded"}{" "}
        <time dateTime={document.created_at}>{formatUtc(document.created_at)}</time>
      </p>
      {(canDownload || canDelete) && (
        <DocumentActions {...actions} canDownload={canDownload} canDelete={canDelete} extract={null} />
      )}
    </div>
  );
}

// The line's one sentence: where the document stands and what happens
// next, from data the page already has.
function Detail({
  entry,
  state,
  canManage,
  explainExtract,
}: {
  entry: DocumentEntry;
  state: DocumentState;
  canManage: boolean;
  explainExtract: boolean;
}) {
  const { runs, fields } = entry;
  const latest = runs[0];

  switch (state) {
    case "uploading":
      // When the row was made, which is when the upload started; elapsed
      // time once the browser has a clock, as a running extraction's.
      return (
        <p>
          Started <time dateTime={entry.document.created_at}>{formatClock(entry.document.created_at)}</time>
          <Elapsed since={entry.document.created_at} spoken="uploading for" />. The file hasn&apos;t arrived yet.
        </p>
      );

    case "ready":
      if (!canManage) return <p>Not extracted yet. An admin can extract it.</p>;
      return (
        <>
          <p>Not extracted yet.</p>
          {/* Beside Extract, what it will do, in words: no signal, no
              control. Once per page. */}
          {explainExtract && <p className="mt-1 max-w-prose">{extractReads()}</p>}
        </>
      );

    case "queued":
      return <p>Waiting to start.</p>;

    case "running":
      // The start time always; elapsed time once the browser has a clock.
      if (latest?.status !== "running") return <p>Extracting.</p>;
      return (
        <p>
          Started <time dateTime={latest.started_at}>{formatClock(latest.started_at)}</time>
          <Elapsed since={latest.started_at} />
        </p>
      );

    case "done": {
      const summary = fieldSummary(fields);
      return (
        <p>
          {summary.read}
          {summary.questions && ` ${summary.questions}`}
          {latest?.status === "failed" && " The latest run failed."}
        </p>
      );
    }

    case "needs-review": {
      const summary = fieldSummary(fields);
      return (
        <p>
          {summary.check}
          {latest?.status === "failed" && " The latest run failed."}
        </p>
      );
    }

    case "failed":
      return <p className="max-w-prose">{failureReason(entry, canManage)}</p>;
  }
}

// Why a document has no usable result, in the catalog's words or the
// page's own, and, for a member, who can do something about it.
function failureReason(entry: DocumentEntry, canManage: boolean): string {
  const { document, runs, staleRun } = entry;
  if (document.status === "uploading") {
    return `The upload never finished, so there is no file. ${
      canManage ? "Delete this entry, then upload the file again." : "An admin can delete this entry."
    }`;
  }
  if (staleRun) {
    return `Stopped responding after ${EXTRACTION_LIMITS.staleRunMinutes} minutes.${
      canManage ? " Extract again to restart it." : " An admin can restart it."
    }`;
  }
  const exit = failedExit(entry);
  const forMember =
    canManage || exit === "download" ? "" : exit === "delete" ? " Only an admin can delete it." : " Only an admin can extract it again.";
  const latest = runs[0];
  if (latest?.status === "failed" && latest.error_code) {
    return `${userFacingError(latest.error_code).message}${forMember}`;
  }
  return `Extraction failed.${forMember}`;
}
