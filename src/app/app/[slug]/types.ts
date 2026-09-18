// What the organization page reads, and what its components take. page.tsx
// fetches these rows and the components only render them, so the design
// preview can render the same components from fixture rows.

export type Role = "owner" | "admin" | "member";

export type Organization = { id: string; name: string; slug: string };

export type DocumentRow = {
  id: string;
  filename: string;
  // uploading, pending, processing, extracted, needs_review, failed
  status: string;
  storage_path: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
};

export type RunRow = {
  id: string;
  document_id: string | null;
  // running, succeeded, failed
  status: string;
  provider: string | null;
  model: string | null;
  attempts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  // numeric(12, 8): PostgREST may send it as a string
  cost_usd: number | string | null;
  latency_ms: number | null;
  error: string | null;
  started_at: string;
};

export type FieldRow = {
  document_id: string;
  name: string;
  value: string | null;
  // numeric(4, 3): may arrive as a string
  confidence: number | string;
  // high, medium, low
  band: string;
  source_text: string | null;
  clarifying_question: string | null;
};

// One document with everything shown about it.
export type DocumentEntry = {
  document: DocumentRow;
  // newest first
  runs: RunRow[];
  // in the order of FIELDS in src/lib/extraction/schema.ts
  fields: FieldRow[];
  // processing, but its run has been running longer than the database's
  // stale limit, so the next Extract click fails it and starts again
  staleRun: boolean;
};
