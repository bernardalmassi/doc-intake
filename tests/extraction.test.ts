// The LLM harness, from the database side and the orchestrator side:
//
//   - the spend ceilings and the hourly rate limit refuse a run before any
//     model call, in open_extraction_run
//   - a run is closed in one transaction and a failed run leaves the
//     document exactly as it was
//   - the orchestrator retries an invalid answer once with the validation
//     error, then fails cleanly with the raw answer kept
//   - runs and fields are readable by tenant members only; anon and other
//     tenants are refused; nobody writes them directly
//   - cost is computed from the pricing table
//
// No model is called: the orchestrator is exercised with fake providers, and
// the RPCs are driven directly with real signed-in sessions against the
// project in .env.test, using only the publishable key. Runs are "forged"
// with chosen token counts to reach the ceilings; that is also a
// demonstration that a tenant admin can do the same, within the clamp (see
// SECURITY.md). The stale-run reaper needs a run older than ten minutes, so
// it is tested in SQL instead: supabase/tests/extraction_stale_runs.sql.
//
// Like tenant-isolation.test.ts, tests here are order-dependent and users
// are signed up once per run.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeCostUsd,
  CONFIDENCE_THRESHOLDS,
  EXTRACTION_LIMITS,
  MAX_OUTPUT_TOKENS,
  PRICING,
  priceForModel,
} from "@/lib/extraction/config";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "@/lib/extraction/providers/types";
import { ProviderError } from "@/lib/extraction/providers/types";
import { runExtraction, toCloseParams, type RunOutcome } from "@/lib/extraction/run";
import { buildJsonSchema, FIELD_NAMES, validateExtraction } from "@/lib/extraction/schema";
import { detectMimeType } from "@/lib/extraction/sniff";

const url = process.env.SUPABASE_TEST_URL;
const publishableKey = process.env.SUPABASE_TEST_PUBLISHABLE_KEY;
const emailDomain = process.env.SUPABASE_TEST_EMAIL_DOMAIN || "example.com";

if (!url || !publishableKey) {
  throw new Error(
    "Set SUPABASE_TEST_URL and SUPABASE_TEST_PUBLISHABLE_KEY in .env.test (see .env.test.example).",
  );
}

const BUCKET = "documents";
const MIN_PASSWORD_LENGTH = 15;
const runId = randomUUID().slice(0, 8);

type TestUser = { client: SupabaseClient; id: string; email: string };
type DocumentRow = { id: string; tenant_id: string; storage_path: string; status: string; filename: string };
type RunRow = {
  id: string;
  tenant_id: string;
  document_id: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  attempts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | number | null;
  latency_ms: number | null;
  error: string | null;
  raw_response: string | null;
  started_at: string;
  finished_at: string | null;
};
type FieldRow = {
  document_id: string;
  run_id: string;
  name: string;
  value: string | null;
  confidence: string | number;
  band: string;
  source_text: string | null;
  clarifying_question: string | null;
};

const RUN_COLUMNS =
  "id, tenant_id, document_id, status, provider, model, attempts, input_tokens, output_tokens, cost_usd, latency_ms, error, raw_response, started_at, finished_at";
const FIELD_COLUMNS = "document_id, run_id, name, value, confidence, band, source_text, clarifying_question";

function newClient() {
  return createClient(url!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function pdfBytes(marker: string) {
  return new TextEncoder().encode(
    `%PDF-1.4\n% doc-intake extraction test ${marker}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
  );
}

async function signUpUser(label: string): Promise<TestUser> {
  const client = newClient();
  const email = `extraction-${label}-${runId}@${emailDomain}`;
  const password = `${randomUUID()}Aa1!`;
  expect(password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(`sign-up for user ${label} failed: ${error.message}`);
  if (!data.session || !data.user) {
    throw new Error("sign-up returned no session: turn off email confirmation for the test project.");
  }
  return { client, id: data.user.id, email };
}

async function createTenant(user: TestUser, label: string): Promise<string> {
  const { data, error } = await user.client.rpc("create_tenant", {
    p_name: `Extraction ${label} ${runId}`,
    p_slug: `ext-${label}-${runId}`,
  });
  if (error) throw new Error(`create_tenant ${label} failed: ${error.message}`);
  return (data as { id: string }).id;
}

// Row-first upload, as the app does it, so the document is 'pending'.
async function uploadDocument(user: TestUser, tenantId: string, filename: string): Promise<DocumentRow> {
  const created = await user.client
    .from("documents")
    .insert({ tenant_id: tenantId, filename })
    .select("id, tenant_id, storage_path, status, filename")
    .single<DocumentRow>();
  if (created.error) throw new Error(`creating a row failed: ${created.error.message}`);
  const blob = new Blob([pdfBytes(filename)], { type: "application/pdf" });
  const upload = await user.client.storage
    .from(BUCKET)
    .upload(created.data.storage_path, blob, { contentType: "application/pdf", upsert: false, cacheControl: "0" });
  if (upload.error) throw new Error(`upload failed: ${upload.error.message}`);
  const done = await user.client.rpc("complete_document_upload", { p_document_id: created.data.id });
  if (done.error) throw new Error(`complete_document_upload failed: ${done.error.message}`);
  return done.data as DocumentRow;
}

async function readDocument(user: TestUser, id: string) {
  const { data, error } = await user.client
    .from("documents")
    .select("id, tenant_id, storage_path, status, filename")
    .eq("id", id)
    .maybeSingle<DocumentRow>();
  if (error) throw error;
  return data;
}

async function readRun(user: TestUser, id: string) {
  const { data, error } = await user.client
    .from("extraction_runs")
    .select(RUN_COLUMNS)
    .eq("id", id)
    .maybeSingle<RunRow>();
  if (error) throw error;
  return data;
}

async function readFields(user: TestUser, documentId: string) {
  const { data, error } = await user.client
    .from("extracted_fields")
    .select(FIELD_COLUMNS)
    .eq("document_id", documentId)
    .order("name");
  if (error) throw error;
  return (data ?? []) as FieldRow[];
}

type Opened = { run_id: string; close_token: string };

function open(user: TestUser, documentId: string) {
  return user.client.rpc("open_extraction_run", { p_document_id: documentId });
}

async function mustOpen(user: TestUser, documentId: string): Promise<Opened> {
  const { data, error } = await open(user, documentId);
  if (error) throw new Error(`open_extraction_run failed: ${error.code} ${error.message}`);
  return (data as Opened[])[0];
}

function close(user: TestUser, runId: string, token: string, outcome: RunOutcome) {
  return user.client.rpc("close_extraction_run", toCloseParams(runId, token, outcome));
}

// A failed run with no fields. The database computes its cost from the
// token counts, so a test drives spend by choosing those.
function failedOutcome(extra: Partial<RunOutcome> = {}): RunOutcome {
  return {
    status: "failed",
    error: "forged by the test suite",
    rawResponse: null,
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    attempts: 1,
    inputTokens: 1000,
    outputTokens: 10,
    latencyMs: 5,
    ...extra,
  } as RunOutcome;
}

// Token counts that cost exactly `costUsd` at Sonnet 5's input price, the
// dearest model on file, so a whole ceiling fits inside one clamped run.
const FORGE_MODEL = "claude-sonnet-5";
function forgedUsage(costUsd: number) {
  const inputTokens = Math.round((costUsd * 1_000_000) / priceForModel(FORGE_MODEL).inputUsdPerMillion);
  if (inputTokens > EXTRACTION_LIMITS.maxInputTokensPerRun) throw new Error("can't forge that much in one run");
  return { provider: "anthropic" as const, model: FORGE_MODEL, inputTokens, outputTokens: 0 };
}

// Opens and immediately closes a run whose recorded cost is `costUsd`.
async function forgeRun(user: TestUser, documentId: string, costUsd: number) {
  const opened = await mustOpen(user, documentId);
  const { error } = await close(user, opened.run_id, opened.close_token, failedOutcome(forgedUsage(costUsd)));
  if (error) throw new Error(`close_extraction_run failed: ${error.code} ${error.message}`);
  const run = await readRun(user, opened.run_id);
  expect(Number(run?.cost_usd)).toBe(costUsd);
  return opened.run_id;
}

// Fake providers ---------------------------------------------------------

function fakeProvider(
  name: "anthropic" | "openai",
  model: string,
  answers: (ProviderResponse | ProviderError)[],
): ExtractionProvider & { requests: ExtractionRequest[] } {
  const requests: ExtractionRequest[] = [];
  return {
    name,
    model,
    requests,
    async extract(request) {
      requests.push(request);
      const next = answers.shift();
      if (!next) throw new Error(`fake ${name} provider has no answer left`);
      if (next instanceof ProviderError) throw next;
      return next;
    },
  };
}

function answer(text: string, model = "claude-haiku-4-5-20251001", inputTokens = 1000, outputTokens = 100): ProviderResponse {
  return { text, inputTokens, outputTokens, model };
}

function validJson(overrides: Record<string, { value: string | null; confidence: number }> = {}) {
  const fields: Record<string, unknown> = {};
  for (const name of FIELD_NAMES) {
    fields[name] = { value: null, confidence: 0.9, source_text: null, clarifying_question: null };
  }
  for (const [name, override] of Object.entries(overrides)) {
    fields[name] = { ...override, source_text: override.value, clarifying_question: null };
  }
  return JSON.stringify(fields);
}

// Setup --------------------------------------------------------------------

let userX: TestUser | undefined; // owner of every tenant below
let userY: TestUser | undefined; // member of tenant P only
const tenants: string[] = [];

let tenantP: string; // lifecycle tests; Y is a member
let tenantQ: string; // rate limit
let tenantC: string; // tenant ceiling
let tenantG1: string; // global ceiling, with C
let tenantG2: string;
let tenantG3: string; // fresh tenant refused by the global ceiling
let tenantS: string; // a run left running
let docP: DocumentRow;
let docQ: DocumentRow;
let docC: DocumentRow;
let docG1: DocumentRow;
let docG2: DocumentRow;
let docG3: DocumentRow;
let docS: DocumentRow;

const x = () => userX!;
const y = () => userY!;

beforeAll(async () => {
  userX = await signUpUser("x");
  userY = await signUpUser("y");

  const make = async (label: string) => {
    const id = await createTenant(x(), label);
    tenants.push(id);
    return id;
  };
  tenantP = await make("p");
  tenantQ = await make("q");
  tenantC = await make("c");
  tenantG1 = await make("g1");
  tenantG2 = await make("g2");
  tenantG3 = await make("g3");
  tenantS = await make("s");

  const join = await x().client
    .from("memberships")
    .insert({ tenant_id: tenantP, user_id: y().id, role: "member" });
  if (join.error) throw new Error(`adding Y to tenant P failed: ${join.error.message}`);

  [docP, docQ, docC, docG1, docG2, docG3, docS] = await Promise.all([
    uploadDocument(x(), tenantP, "p.pdf"),
    uploadDocument(x(), tenantQ, "q.pdf"),
    uploadDocument(x(), tenantC, "c.pdf"),
    uploadDocument(x(), tenantG1, "g1.pdf"),
    uploadDocument(x(), tenantG2, "g2.pdf"),
    uploadDocument(x(), tenantG3, "g3.pdf"),
    uploadDocument(x(), tenantS, "s.pdf"),
  ]);
});

afterAll(async () => {
  const problems: string[] = [];
  if (userX) {
    for (const id of tenants) {
      const { data: files, error: listError } = await userX.client.storage.from(BUCKET).list(id);
      if (listError) {
        problems.push(`list files in ${id}: ${listError.message}`);
        continue;
      }
      if (files.length > 0) {
        const { error } = await userX.client.storage.from(BUCKET).remove(files.map((f) => `${id}/${f.name}`));
        if (error) problems.push(`remove files in ${id}: ${error.message}`);
      }
    }
    // runs and fields cascade with the tenant, taking the forged spend with them
    for (const id of tenants) {
      const { error } = await userX.client.rpc("delete_tenant", { p_tenant_id: id });
      if (error) problems.push(`delete_tenant ${id}: ${error.message}`);
    }
  }
  for (const user of [userX, userY]) {
    if (!user) continue;
    const { error } = await user.client.rpc("delete_own_account");
    if (error) problems.push(`delete_own_account ${user.email}: ${error.message}`);
  }
  if (problems.length > 0) throw new Error(`cleanup left data behind:\n${problems.join("\n")}`);
});

// Tests --------------------------------------------------------------------

describe("configuration", () => {
  it("the limits in config.ts match the limits the database enforces", async () => {
    const { data, error } = await x().client.from("extraction_limits").select("*").single();
    expect(error).toBeNull();
    expect(Number(data!.tenant_monthly_ceiling_usd)).toBe(EXTRACTION_LIMITS.tenantMonthlyCeilingUsd);
    expect(Number(data!.global_monthly_ceiling_usd)).toBe(EXTRACTION_LIMITS.globalMonthlyCeilingUsd);
    expect(data!.hourly_run_limit).toBe(EXTRACTION_LIMITS.hourlyRunLimit);
    expect(data!.max_input_tokens_per_run).toBe(EXTRACTION_LIMITS.maxInputTokensPerRun);
    expect(data!.max_output_tokens_per_run).toBe(EXTRACTION_LIMITS.maxOutputTokensPerRun);
    expect(data!.stale_run_minutes).toBe(EXTRACTION_LIMITS.staleRunMinutes);
  });

  it("the prices in config.ts match the prices the database charges", async () => {
    const { data, error } = await x().client.from("extraction_model_prices").select("*").order("model");
    expect(error).toBeNull();
    const fromDb = Object.fromEntries(
      (data ?? []).map((row) => [
        row.model,
        {
          provider: row.provider,
          inputUsdPerMillion: Number(row.input_usd_per_million),
          outputUsdPerMillion: Number(row.output_usd_per_million),
          checkedOn: row.checked_on,
          source: row.source,
        },
      ]),
    );
    expect(fromDb).toEqual(PRICING);
  });

  it("cost is computed from the pricing table for a known token count", () => {
    // Haiku 4.5: $1 per million in, $5 per million out
    expect(PRICING["claude-haiku-4-5-20251001"]).toMatchObject({ inputUsdPerMillion: 1, outputUsdPerMillion: 5 });
    expect(computeCostUsd("claude-haiku-4-5-20251001", 10_000, 500)).toBe(0.0125);
    // gpt-5-nano: $0.05 in, $0.40 out; the served snapshot id carries a date
    expect(computeCostUsd("gpt-5-nano-2025-08-07", 200_000, 1_000)).toBe(0.0104);
    expect(computeCostUsd("gpt-5-nano", 0, 0)).toBe(0);
    // clamped to the per-run maximum
    expect(computeCostUsd("claude-haiku-4-5-20251001", 5_000_000, 100_000)).toBe(
      computeCostUsd("claude-haiku-4-5-20251001", EXTRACTION_LIMITS.maxInputTokensPerRun, EXTRACTION_LIMITS.maxOutputTokensPerRun),
    );
    expect(() => computeCostUsd("no-such-model", 1, 1)).toThrow(/no price on file/);
    expect(() => computeCostUsd("gpt-5-nano", -1, 1)).toThrow();
  });

  it("magic bytes decide the type, not the declared one", () => {
    expect(detectMimeType(pdfBytes("x"))).toBe("application/pdf");
    expect(detectMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(detectMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectMimeType(new TextEncoder().encode("hello"))).toBeNull();
    expect(detectMimeType(new Uint8Array([]))).toBeNull();
  });
});

describe("validation", () => {
  it("rejects malformed answers with a specific message", () => {
    expect(validateExtraction("not json")).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    expect(validateExtraction("[]")).toMatchObject({ ok: false, error: expect.stringMatching(/JSON object/) });
    const missing = validateExtraction("{}");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/document_type is missing/);

    const badDate = validateExtraction(validJson({ document_date: { value: "2026-02-30", confidence: 0.9 } }));
    expect(badDate).toMatchObject({ ok: false, error: expect.stringMatching(/document_date.*YYYY-MM-DD/) });
    const badAmount = validateExtraction(validJson({ total_amount: { value: "1,234.00", confidence: 0.9 } }));
    expect(badAmount).toMatchObject({ ok: false, error: expect.stringMatching(/total_amount/) });
    const badCurrency = validateExtraction(validJson({ currency: { value: "dollars", confidence: 0.9 } }));
    expect(badCurrency).toMatchObject({ ok: false, error: expect.stringMatching(/currency/) });
    const badEnum = validateExtraction(validJson({ document_type: { value: "memo", confidence: 0.9 } }));
    expect(badEnum).toMatchObject({ ok: false, error: expect.stringMatching(/document_type.*one of/) });
    const badConfidence = validateExtraction(validJson({ title: { value: "x", confidence: 1.5 } }));
    expect(badConfidence).toMatchObject({ ok: false, error: expect.stringMatching(/confidence/) });
  });

  it("treats empty strings as absent and the schema has no unions", () => {
    const text = validJson({ title: { value: "", confidence: 0.9 }, currency: { value: "   ", confidence: 0.5 } });
    const result = validateExtraction(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fields.find((f) => f.name === "title")).toMatchObject({ value: null, source_text: null });
      expect(result.fields.find((f) => f.name === "currency")?.value).toBeNull();
    }
    // Anthropic rejects schemas with more than 16 union-typed parameters
    expect(JSON.stringify(buildJsonSchema())).not.toMatch(/anyOf|oneOf|"null"/);
  });

  it("accepts a well-formed answer", () => {
    const result = validateExtraction(
      validJson({ document_date: { value: "2026-09-18", confidence: 0.95 }, total_amount: { value: "1234.56", confidence: 0.7 } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fields).toHaveLength(FIELD_NAMES.length);
      expect(result.fields.find((f) => f.name === "total_amount")).toMatchObject({ value: "1234.56", confidence: 0.7 });
    }
  });
});

describe("orchestrator (fake providers)", () => {
  const input = { bytes: pdfBytes("fake"), mimeType: "application/pdf" as const, filename: "fake.pdf" };

  it("an invalid answer is retried once with the validation error, then the run fails cleanly", async () => {
    const primary = fakeProvider("anthropic", "claude-haiku-4-5-20251001", [
      answer("{ this is not json"),
      answer('{"still": "wrong"}', "claude-haiku-4-5-20251001", 1200, 50),
    ]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(primary.requests).toHaveLength(2);
    expect(primary.requests[0].previousAttempt).toBeUndefined();
    expect(primary.requests[0].maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    // the retry carries the previous answer and what was wrong with it
    expect(primary.requests[1].previousAttempt?.rawResponse).toBe("{ this is not json");
    expect(primary.requests[1].previousAttempt?.retryPrompt).toMatch(/not valid JSON/);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.attempts).toBe(2);
    expect(outcome.error).toMatch(/after 1 retry/);
    expect(outcome.error).toMatch(/document_type is missing/);
    expect(outcome.rawResponse).toBe('{"still": "wrong"}');
    // both calls are paid for
    expect(outcome.inputTokens).toBe(2200);
    expect(outcome.outputTokens).toBe(150);
    expect(outcome.provider).toBe("anthropic");
  });

  it("a valid answer is gated by confidence", async () => {
    const text = validJson({
      title: { value: "Invoice 42", confidence: 0.99 },
      total_amount: { value: "10.00", confidence: 0.7 },
      due_date: { value: "2026-10-01", confidence: 0.2 },
    });
    const primary = fakeProvider("openai", "gpt-5-nano", [answer(text, "gpt-5-nano-2025-08-07", 500, 80)]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.model).toBe("gpt-5-nano-2025-08-07");
    const byName = Object.fromEntries(outcome.fields.map((f) => [f.name, f]));
    expect(byName.title).toMatchObject({ band: "high", clarifying_question: null });
    expect(byName.total_amount.band).toBe("medium");
    expect(byName.total_amount.clarifying_question).toMatch(/10\.00/);
    expect(byName.due_date).toMatchObject({ band: "low", value: "2026-10-01" });
    expect(outcome.documentStatus).toBe("needs_review");
    expect(CONFIDENCE_THRESHOLDS.medium).toBeLessThanOrEqual(0.7);
  });

  it("a timeout or 5xx on the primary falls back to the other provider", async () => {
    const primary = fakeProvider("anthropic", "claude-haiku-4-5-20251001", [
      new ProviderError("anthropic", "transport", "request timed out"),
    ]);
    const fallback = fakeProvider("openai", "gpt-5-nano", [answer(validJson(), "gpt-5-nano-2025-08-07", 700, 60)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "succeeded", provider: "openai", attempts: 2, inputTokens: 700 });

    const server = fakeProvider("openai", "gpt-5-nano", [new ProviderError("openai", "server", "bad gateway", 502)]);
    const second = fakeProvider("anthropic", "claude-haiku-4-5-20251001", [answer(validJson())]);
    const outcome2 = await runExtraction({ ...input, primary: server, fallback: second });
    expect(outcome2).toMatchObject({ status: "succeeded", provider: "anthropic", attempts: 2 });
  });

  it("a 4xx or a refusal fails without falling back", async () => {
    const primary = fakeProvider("anthropic", "claude-haiku-4-5-20251001", [
      new ProviderError("anthropic", "client", "invalid request", 400),
    ]);
    const fallback = fakeProvider("openai", "gpt-5-nano", [answer(validJson())]);
    const outcome = await runExtraction({ ...input, primary, fallback });
    expect(fallback.requests).toHaveLength(0);
    expect(outcome).toMatchObject({ status: "failed", attempts: 1, inputTokens: 0, rawResponse: null });
    if (outcome.status === "failed") expect(outcome.error).toMatch(/anthropic client 400/);
  });
});

describe("run lifecycle in the database", () => {
  let failedRun: string;
  let clampedRun: string;

  it("a member cannot open a run; anon cannot either", async () => {
    const asMember = await open(y(), docP.id);
    expect(asMember.data).toBeNull();
    expect(asMember.error?.code).toBe("42501");

    const anon = await newClient().rpc("open_extraction_run", { p_document_id: docP.id });
    expect(anon.error?.code).toBe("42501");

    expect((await readDocument(x(), docP.id))?.status).toBe("pending");
  });

  it("opening marks the document processing and refuses a second open", async () => {
    const opened = await mustOpen(x(), docP.id);
    expect(opened.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(opened.close_token).toMatch(/^[0-9a-f-]{36}$/);

    expect((await readDocument(x(), docP.id))?.status).toBe("processing");
    const run = await readRun(x(), opened.run_id);
    expect(run).toMatchObject({ status: "running", document_id: docP.id, cost_usd: null, finished_at: null });

    const again = await open(x(), docP.id);
    expect(again.error?.code).toBe("55000");

    // close with a wrong token, as someone else holding the real token, and
    // as anon: all refused
    const wrongToken = await close(x(), opened.run_id, randomUUID(), failedOutcome());
    expect(wrongToken.error?.code).toBe("42501");
    const asMember = await close(y(), opened.run_id, opened.close_token, failedOutcome());
    expect(asMember.error?.code).toBe("42501");
    const anon = await newClient().rpc("close_extraction_run", toCloseParams(opened.run_id, opened.close_token, failedOutcome()));
    expect(anon.error?.code).toBe("42501");
    expect((await readRun(x(), opened.run_id))?.status).toBe("running");

    // the real close: a run that never reached a model records no usage
    const closed = await close(
      x(),
      opened.run_id,
      opened.close_token,
      failedOutcome({ error: "first failure", provider: null, model: null, inputTokens: 0, outputTokens: 0, attempts: 0 }),
    );
    expect(closed.error).toBeNull();
    expect((await readDocument(x(), docP.id))?.status).toBe("pending");
    expect(await readRun(x(), opened.run_id)).toMatchObject({
      status: "failed",
      provider: null,
      model: null,
      input_tokens: null,
      cost_usd: null,
      error: "first failure",
    });

    const twice = await close(x(), opened.run_id, opened.close_token, failedOutcome());
    expect(twice.error?.code).toBe("42501");
    failedRun = opened.run_id;
  });

  it("a failed run is recorded with its raw response and leaves the document untouched", async () => {
    const before = await readDocument(x(), docP.id);
    expect(before?.status).toBe("pending");
    expect(await readFields(x(), docP.id)).toEqual([]);

    const primary = fakeProvider("anthropic", "claude-haiku-4-5-20251001", [
      answer("nope"),
      answer('{"document_type": 1}', "claude-haiku-4-5-20251001", 900, 40),
    ]);
    const opened = await mustOpen(x(), docP.id);
    const outcome = await runExtraction({
      bytes: pdfBytes("p"),
      mimeType: "application/pdf",
      filename: docP.filename,
      primary,
      fallback: null,
    });
    expect(outcome.status).toBe("failed");
    const closed = await close(x(), opened.run_id, opened.close_token, outcome);
    expect(closed.error).toBeNull();

    const run = await readRun(x(), opened.run_id);
    expect(run).toMatchObject({
      status: "failed",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      attempts: 2,
      input_tokens: 1900,
      output_tokens: 140,
      raw_response: '{"document_type": 1}',
    });
    expect(run?.error).toMatch(/failed validation/);
    // the database priced it from its own table: 1900 in, 140 out at Haiku rates
    expect(Number(run?.cost_usd)).toBe(0.0026);
    expect(Number(run?.cost_usd)).toBe(computeCostUsd("claude-haiku-4-5-20251001", 1900, 140));
    expect(run?.finished_at).not.toBeNull();

    // the document: same status, same filename, still no fields
    const after = await readDocument(x(), docP.id);
    expect(after).toEqual(before);
    expect(await readFields(x(), docP.id)).toEqual([]);
  });

  it("a close cannot carry fields on failure, a cost, an unknown model, or a mismatched provider", async () => {
    const opened = await mustOpen(x(), docP.id);
    const base = toCloseParams(opened.run_id, opened.close_token, failedOutcome());

    const withFields = await x().client.rpc("close_extraction_run", {
      ...base,
      p_fields: [{ name: "title", value: "x", confidence: 0.9, band: "high", source_text: null, clarifying_question: null }],
    });
    expect(withFields.error?.code).toBe("22023");

    // there is no cost parameter any more
    const withCost = await x().client.rpc("close_extraction_run", { ...base, p_cost_usd: 0 });
    expect(withCost.error?.code).toBe("PGRST202");

    const unknownModel = await x().client.rpc("close_extraction_run", { ...base, p_model: "gpt-9-ultra" });
    expect(unknownModel.error?.code).toBe("22023");
    expect(unknownModel.error?.message).toMatch(/no price on file/);

    const wrongProvider = await x().client.rpc("close_extraction_run", { ...base, p_provider: "openai" });
    expect(wrongProvider.error?.code).toBe("22023");

    const tokensNoModel = await x().client.rpc("close_extraction_run", { ...base, p_model: null, p_provider: null });
    expect(tokensNoModel.error?.code).toBe("22023");

    expect((await readRun(x(), opened.run_id))?.status).toBe("running");
    expect(await readFields(x(), docP.id)).toEqual([]);

    // absurd token counts are clamped, so the recorded cost is bounded
    const clamped = await x().client.rpc("close_extraction_run", {
      ...base,
      p_input_tokens: 2_000_000_000,
      p_output_tokens: 2_000_000_000,
    });
    expect(clamped.error).toBeNull();
    const run = await readRun(x(), opened.run_id);
    expect(run).toMatchObject({
      status: "failed",
      input_tokens: EXTRACTION_LIMITS.maxInputTokensPerRun,
      output_tokens: EXTRACTION_LIMITS.maxOutputTokensPerRun,
    });
    expect(Number(run?.cost_usd)).toBe(
      computeCostUsd("claude-haiku-4-5-20251001", EXTRACTION_LIMITS.maxInputTokensPerRun, EXTRACTION_LIMITS.maxOutputTokensPerRun),
    );
    // that one forged run, at the clamp, is worth about 84 cents at Haiku rates
    expect(Number(run?.cost_usd)).toBe(0.84096);
    clampedRun = opened.run_id;
  });

  it("a successful run writes gated fields; a low field sends the document to review", async () => {
    const primary = fakeProvider("openai", "gpt-5-nano", [
      answer(
        validJson({
          title: { value: "Invoice 42", confidence: 0.99 },
          total_amount: { value: "10.00", confidence: 0.7 },
          due_date: { value: "2026-10-01", confidence: 0.2 },
        }),
        "gpt-5-nano-2025-08-07",
        500,
        80,
      ),
    ]);
    const opened = await mustOpen(x(), docP.id);
    const outcome = await runExtraction({
      bytes: pdfBytes("p"),
      mimeType: "application/pdf",
      filename: docP.filename,
      primary,
      fallback: null,
    });
    const closed = await close(x(), opened.run_id, opened.close_token, outcome);
    expect(closed.error).toBeNull();

    expect((await readDocument(x(), docP.id))?.status).toBe("needs_review");
    const fields = await readFields(x(), docP.id);
    expect(fields).toHaveLength(FIELD_NAMES.length);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.title).toMatchObject({ value: "Invoice 42", band: "high", clarifying_question: null, run_id: opened.run_id });
    expect(byName.total_amount.band).toBe("medium");
    expect(byName.total_amount.clarifying_question).toMatch(/10\.00/);
    expect(byName.due_date).toMatchObject({ value: "2026-10-01", band: "low" });
    expect(Number(byName.title.confidence)).toBe(0.99);

    const run = await readRun(x(), opened.run_id);
    expect(run).toMatchObject({ status: "succeeded", provider: "openai", model: "gpt-5-nano-2025-08-07", attempts: 1 });
    // priced by the snapshot's prefix, gpt-5-nano
    expect(Number(run?.cost_usd)).toBe(computeCostUsd("gpt-5-nano", 500, 80));
  });

  it("a later successful run replaces the fields and can mark the document extracted", async () => {
    const primary = fakeProvider("anthropic", "claude-haiku-4-5-20251001", [
      answer(validJson({ title: { value: "Invoice 43", confidence: 0.95 } })),
    ]);
    const opened = await mustOpen(x(), docP.id);
    const outcome = await runExtraction({
      bytes: pdfBytes("p"),
      mimeType: "application/pdf",
      filename: docP.filename,
      primary,
      fallback: null,
    });
    const closed = await close(x(), opened.run_id, opened.close_token, outcome);
    expect(closed.error).toBeNull();

    expect((await readDocument(x(), docP.id))?.status).toBe("extracted");
    const fields = await readFields(x(), docP.id);
    expect(fields).toHaveLength(FIELD_NAMES.length);
    expect(fields.every((f) => f.run_id === opened.run_id)).toBe(true);
    expect(fields.find((f) => f.name === "title")).toMatchObject({ value: "Invoice 43", band: "high" });
    expect(fields.find((f) => f.name === "due_date")).toMatchObject({ value: null, band: "high" });

    // every run so far is still there
    const runs = await x().client.from("extraction_runs").select("id").eq("tenant_id", tenantP);
    expect(runs.data?.map((r) => r.id)).toContain(failedRun);
    expect(runs.data?.map((r) => r.id)).toContain(clampedRun);
    expect(runs.data).toHaveLength(5);
  });

  it("a fresh running run is not reaped by the next open", async () => {
    // The reaper only fails runs older than stale_run_minutes; a run opened
    // seconds ago just blocks the next open. Reaping itself is tested in
    // supabase/tests/extraction_stale_runs.sql, where started_at can be set.
    const opened = await mustOpen(x(), docS.id);
    const again = await open(x(), docS.id);
    expect(again.error?.code).toBe("55000");
    expect(again.error?.message).toMatch(/already running/);
    expect((await readRun(x(), opened.run_id))?.status).toBe("running");
    expect((await readDocument(x(), docS.id))?.status).toBe("processing");
    const closed = await close(
      x(),
      opened.run_id,
      opened.close_token,
      failedOutcome({ provider: null, model: null, inputTokens: 0, outputTokens: 0, attempts: 0 }),
    );
    expect(closed.error).toBeNull();
    expect((await readDocument(x(), docS.id))?.status).toBe("pending");
  });

  it("nobody can write runs or fields directly", async () => {
    const insertRun = await x().client
      .from("extraction_runs")
      .insert({ tenant_id: tenantP, document_id: docP.id, previous_document_status: "pending" });
    expect(insertRun.error?.code).toBe("42501");

    const updateRun = await x().client.from("extraction_runs").update({ cost_usd: 0 }).eq("tenant_id", tenantP);
    expect(updateRun.error?.code).toBe("42501");

    const deleteRun = await x().client.from("extraction_runs").delete().eq("tenant_id", tenantP);
    expect(deleteRun.error?.code).toBe("42501");

    const deleteFields = await x().client.from("extracted_fields").delete().eq("document_id", docP.id);
    expect(deleteFields.error?.code).toBe("42501");

    // (PostgREST refuses an unfiltered update before the database sees it)
    const updateLimits = await x().client
      .from("extraction_limits")
      .update({ hourly_run_limit: 1000 })
      .eq("singleton", true);
    expect(updateLimits.error?.code).toBe("42501");

    const updatePrices = await x().client
      .from("extraction_model_prices")
      .update({ input_usd_per_million: 0 })
      .eq("model", "gpt-5-nano");
    expect(updatePrices.error?.code).toBe("42501");

    expect(await readFields(x(), docP.id)).toHaveLength(FIELD_NAMES.length);
  });
});

describe("limits", () => {
  it("the tenant monthly spend ceiling blocks a call", async () => {
    // one run that cost exactly the ceiling
    await forgeRun(x(), docC.id, EXTRACTION_LIMITS.tenantMonthlyCeilingUsd);
    expect((await readDocument(x(), docC.id))?.status).toBe("pending");

    const refused = await open(x(), docC.id);
    expect(refused.data).toBeNull();
    expect(refused.error?.code).toBe("53400");
    expect(refused.error?.message).toMatch(/this organization has reached its monthly extraction spend ceiling/);

    // nothing was opened: no new run, document untouched
    const runs = await x().client.from("extraction_runs").select("id").eq("tenant_id", tenantC);
    expect(runs.data).toHaveLength(1);
    expect((await readDocument(x(), docC.id))?.status).toBe("pending");
  });

  it("the hourly rate limit blocks a call", async () => {
    for (let i = 0; i < EXTRACTION_LIMITS.hourlyRunLimit; i++) {
      await forgeRun(x(), docQ.id, 0);
    }
    const refused = await open(x(), docQ.id);
    expect(refused.data).toBeNull();
    expect(refused.error?.code).toBe("54000");
    expect(refused.error?.message).toMatch(new RegExp(`${EXTRACTION_LIMITS.hourlyRunLimit} extraction runs per hour`));

    const runs = await x().client.from("extraction_runs").select("id").eq("tenant_id", tenantQ);
    expect(runs.data).toHaveLength(EXTRACTION_LIMITS.hourlyRunLimit);
    expect((await readDocument(x(), docQ.id))?.status).toBe("pending");
  });

  it("the global monthly spend ceiling blocks a call for a tenant that has spent nothing", async () => {
    // C already carries one tenant ceiling's worth; two more tenants bring
    // the month's total to the global ceiling
    const remaining = EXTRACTION_LIMITS.globalMonthlyCeilingUsd - EXTRACTION_LIMITS.tenantMonthlyCeilingUsd;
    await forgeRun(x(), docG1.id, EXTRACTION_LIMITS.tenantMonthlyCeilingUsd);
    await forgeRun(x(), docG2.id, remaining - EXTRACTION_LIMITS.tenantMonthlyCeilingUsd);

    const refused = await open(x(), docG3.id);
    expect(refused.data).toBeNull();
    expect(refused.error?.code).toBe("53400");
    expect(refused.error?.message).toMatch(/across all organizations/);

    const runs = await x().client.from("extraction_runs").select("id").eq("tenant_id", tenantG3);
    expect(runs.data).toEqual([]);
    expect((await readDocument(x(), docG3.id))?.status).toBe("pending");
  });
});

describe("reading runs and fields", () => {
  it("a member of the tenant sees its runs and fields", async () => {
    const runs = await y().client.from("extraction_runs").select("id, status").eq("tenant_id", tenantP);
    expect(runs.error).toBeNull();
    expect(runs.data).toHaveLength(5);
    expect(await readFields(y(), docP.id)).toHaveLength(FIELD_NAMES.length);
  });

  it("cross-tenant reads of runs and fields return nothing", async () => {
    // Y is not a member of Q, which has runs, or of C
    const runs = await y().client.from("extraction_runs").select("id").eq("tenant_id", tenantQ);
    expect(runs.error).toBeNull();
    expect(runs.data).toEqual([]);
    const fields = await y().client.from("extracted_fields").select("name").neq("document_id", docP.id);
    expect(fields.error).toBeNull();
    expect(fields.data).toEqual([]);
    const unfiltered = await y().client.from("extraction_runs").select("tenant_id");
    expect(new Set(unfiltered.data?.map((r) => r.tenant_id))).toEqual(new Set([tenantP]));

    // control: the owner sees Q's runs
    const own = await x().client.from("extraction_runs").select("id").eq("tenant_id", tenantQ);
    expect(own.data).toHaveLength(EXTRACTION_LIMITS.hourlyRunLimit);
  });

  it("anon is refused everywhere", async () => {
    const anon = newClient();
    for (const table of ["extraction_runs", "extracted_fields", "extraction_limits", "extraction_model_prices"]) {
      const { data, error } = await anon.from(table).select("*").limit(1);
      expect(data, table).toBeNull();
      expect(error?.code, table).toBe("42501");
    }
    const opened = await anon.rpc("open_extraction_run", { p_document_id: docP.id });
    expect(opened.error?.code).toBe("42501");
    const closed = await anon.rpc("close_extraction_run", toCloseParams(randomUUID(), randomUUID(), failedOutcome()));
    expect(closed.error?.code).toBe("42501");
  });
});
