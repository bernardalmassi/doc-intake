import { panelClass } from "@/app/ui";
import { FIELDS } from "@/lib/extraction/schema";

export type RunRow = {
  id: string;
  document_id: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  attempts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | string | null;
  latency_ms: number | null;
  error: string | null;
  started_at: string;
};

export type FieldRow = {
  document_id: string;
  name: string;
  value: string | null;
  confidence: number | string;
  band: string;
  source_text: string | null;
  clarifying_question: string | null;
};

// No green or amber: the accent is kept for what needs review, and a low
// field is what puts a document in needs_review. Item 9 redesigns this.
const bandClass: Record<string, string> = {
  high: "text-fg",
  medium: "text-fg",
  low: "text-accent",
};

function formatCost(cost: number | string | null) {
  if (cost === null) return "";
  return `$${Number(cost).toFixed(6)}`;
}

function labelOf(name: string) {
  return FIELDS.find((f) => f.name === name)?.label ?? name;
}

// The latest run and the current fields for one document. Everything shown
// here is what the tenant's members can read; the database decides that.
export function ExtractionPanel({
  filename,
  run,
  fields,
}: {
  filename: string;
  run: RunRow | null;
  fields: FieldRow[];
}) {
  if (!run && fields.length === 0) return null;

  return (
    <div className={`mt-6 max-w-4xl ${panelClass}`}>
      <h3 className="font-medium">{filename}</h3>
      {run && (
        <p className="mt-1 text-sm text-muted tabular-nums">
          Last run {run.status}
          {run.provider && ` with ${run.provider} (${run.model})`}
          {run.input_tokens !== null && `, ${run.input_tokens} in / ${run.output_tokens} out tokens`}
          {run.cost_usd !== null && `, ${formatCost(run.cost_usd)}`}
          {run.latency_ms !== null && `, ${(run.latency_ms / 1000).toFixed(1)} s`}
          {run.attempts > 1 && `, ${run.attempts} calls`}
          {" · "}
          {new Date(run.started_at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC
          {run.error && <span className="block text-danger">{run.error}</span>}
        </p>
      )}
      {fields.length > 0 && (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-4 font-normal">Field</th>
              <th className="py-1 pr-4 font-normal">Value</th>
              <th className="py-1 pr-4 font-normal">Confidence</th>
              <th className="py-1 pr-4 font-normal">Source</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field.name} className="border-t border-line align-top">
                <td className="py-1 pr-4">{labelOf(field.name)}</td>
                <td className="py-1 pr-4">
                  {field.value ?? <span className="text-muted">not found</span>}
                  {field.clarifying_question && (
                    <span className="block text-muted">{field.clarifying_question}</span>
                  )}
                </td>
                <td className={`py-1 pr-4 tabular-nums ${bandClass[field.band] ?? ""}`}>
                  {Number(field.confidence).toFixed(2)} {field.band}
                </td>
                <td className="py-1 pr-4 text-muted">{field.source_text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
