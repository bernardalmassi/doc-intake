// The queued extraction run, against the TEST project (docs/worker-design.md,
// section 10):
//
//   - the limits and prices in config.ts match the tables the database
//     enforces and charges from
//   - enqueue_extraction_run is the only user entry point: admins only, a
//     queued run with no token, one run at a time per document, the hourly
//     limit; the worker's claim and finish, and the private, pgmq and net
//     schemas, are out of every user's reach
//   - the worker, run in-process by the local runner
//     (tests/helpers/local-worker.ts) with fake or replayed providers,
//     claims the run, checks the file before any model call, and finishes
//     it: gated fields, a failure that restores the document, a fallback,
//     an unpriced model finished as an estimate, a forged page count or a
//     file that isn't its type failed with no call at 0 USD, an idle queue
//   - delete_tenant waits for a run in flight
//   - members see a run queued, then running, then ended; other tenants
//     and anon see nothing
//   - the whole suite spends under 0.01 USD
//
// Users sign in with the publishable key; only the local runner uses the
// test project's secret key. No model is called. The spend ceilings are
// tested in test:db (supabase/tests/extraction_queue.sql), inside a
// rolled-back transaction: spend is recorded in an append-only ledger now,
// so a ceiling reached here would block the test project for the rest of
// the month. So is everything that needs a run older than the stale limit
// (supabase/tests/extraction_stale_runs.sql).
//
// Like tenant-isolation.test.ts, tests here are order-dependent and users
// are signed up once per run. The runner claims whatever is next in the
// test project's queue, so nothing else may enqueue there while this runs
// (the Vitest config runs one file at a time).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPdf } from "../evals/pdf";
import { FIXTURES } from "../evals/fixtures";
import { committedPdf, loadRecording } from "../evals/harness";
import { replayProvider } from "../evals/recording";
import { classifyRunError, isCostEstimated } from "@/lib/errors";
import { computeCostUsd, dearestModelFor, EXTRACTION_LIMITS, MAX_OUTPUT_TOKENS, PRICING, withCountMargin } from "@/lib/extraction/config";
import type { ProviderPair } from "@/lib/extraction/delivery";
import { countPages } from "@/lib/extraction/pages";
import { ProviderError, type ExtractionProvider } from "@/lib/extraction/providers/types";
import { toFinishParams, type RunOutcome } from "@/lib/extraction/run";
import { FIELD_NAMES } from "@/lib/extraction/schema";
import { setLogSink } from "@/lib/log";
import { APP_PROJECT_REF, TEST_PROJECT_REF } from "@/lib/extraction/worker-target";
import { answer, fakeProvider, validJson } from "./helpers/fake-provider";
import { runLocalWorker, runWorkerPointedAt } from "./helpers/local-worker";
import { SUPABASE_TEST_PUBLISHABLE_KEY, SUPABASE_TEST_URL, testEmail } from "./helpers/supabase-target";

// the test project, never the app's: the import throws if they match
const url = SUPABASE_TEST_URL;
const publishableKey = SUPABASE_TEST_PUBLISHABLE_KEY;

const BUCKET = "documents";
const MIN_PASSWORD_LENGTH = 15;
const runId = randomUUID().slice(0, 8);
// what the suite may spend in all, and what one fake call costs: gpt-5-nano,
// 1 000 tokens in and 100 out
const SUITE_BUDGET_USD = 0.01;
const NANO = "gpt-5-nano";
const NANO_SNAPSHOT = "gpt-5-nano-2025-08-07";

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
  page_count: number | null;
  started_at: string;
  claimed_at: string | null;
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

// every column a member may read: all but queue_msg_id (20260925000004)
const RUN_COLUMNS =
  "id, tenant_id, document_id, status, provider, model, attempts, input_tokens, output_tokens, cost_usd, latency_ms, error, raw_response, page_count, started_at, claimed_at, finished_at";
const FIELD_COLUMNS = "document_id, run_id, name, value, confidence, band, source_text, clarifying_question";

function newClient() {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signUpUser(label: string): Promise<TestUser> {
  const client = newClient();
  const email = testEmail(`extraction-${label}-${runId}`);
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

// A real, countable one-page PDF (evals/pdf.ts): the worker recounts pages
// before any model call.
function onePagePdf(label: string): Uint8Array {
  return buildPdf([[{ kind: "text", x: 72, y: 720, text: `doc-intake extraction test ${label}` }]]);
}

// Row-first upload, as the app does it, so the document is 'pending'.
async function uploadDocument(user: TestUser, tenantId: string, filename: string, bytes = onePagePdf(filename)): Promise<DocumentRow> {
  const created = await user.client
    .from("documents")
    .insert({ tenant_id: tenantId, filename })
    .select("id, tenant_id, storage_path, status, filename")
    .single<DocumentRow>();
  if (created.error) throw new Error(`creating a row failed: ${created.error.message}`);
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
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
  const { data, error } = await user.client.from("extraction_runs").select(RUN_COLUMNS).eq("id", id).maybeSingle<RunRow>();
  if (error) throw error;
  return data;
}

async function readFields(user: TestUser, documentId: string) {
  const { data, error } = await user.client.from("extracted_fields").select(FIELD_COLUMNS).eq("document_id", documentId).order("name");
  if (error) throw error;
  return (data ?? []) as FieldRow[];
}

function enqueue(user: TestUser, documentId: string, pageCount: number | null = 1) {
  return user.client.rpc("enqueue_extraction_run", { p_document_id: documentId, p_page_count: pageCount });
}

async function mustEnqueue(user: TestUser, documentId: string, pageCount: number | null = 1): Promise<string> {
  const { data, error } = await enqueue(user, documentId, pageCount);
  if (error) throw new Error(`enqueue_extraction_run failed: ${error.code} ${error.message}`);
  return data as string;
}

// One pass of the worker, which must claim and deliver `expected`.
async function deliver(expected: string, providers: ProviderPair) {
  const result = await runLocalWorker(providers);
  if (result.kind !== "delivered") throw new Error(`the runner did not deliver ${expected}: ${result.kind}`);
  expect(result.runId).toBe(expected);
  return result;
}

const only = (primary: ExtractionProvider): ProviderPair => ({ primary, fallback: null });
// a provider that must not be called: the preflight stops the run first
const never = () => fakeProvider("openai", NANO, []);
// an answer that costs nothing: the call failed without a response
const rejected = () => fakeProvider("openai", NANO, [new ProviderError("openai", "client", "invalid request", 400)]);
const valid = (overrides: Parameters<typeof validJson>[0] = {}) =>
  fakeProvider("openai", NANO, [answer(validJson(overrides), NANO_SNAPSHOT, 1000, 100)]);

// Setup --------------------------------------------------------------------

let userX: TestUser | undefined; // owner of every tenant below
let userY: TestUser | undefined; // member of tenant P only
const tenants: string[] = [];

let tenantP: string; // queued, running, ended; Y is a member
let tenantF: string; // failures and the fallback
let tenantU: string; // an unpriced model
let tenantV: string; // preflight refusals
let tenantW: string; // page counts sent with the enqueue
let tenantQ: string; // the hourly limit
let tenantD: string; // deletion while a run is in flight
let tenantR: string; // a replayed fixture
let docP: DocumentRow;
let docF: DocumentRow;
let docU: DocumentRow;
let docV: DocumentRow;
let docW: DocumentRow;
let docsQ: DocumentRow[];
let docD: DocumentRow;

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
  tenantF = await make("f");
  tenantU = await make("u");
  tenantV = await make("v");
  tenantW = await make("w");
  tenantQ = await make("q");
  tenantD = await make("d");
  tenantR = await make("r");

  const join = await x().client.from("memberships").insert({ tenant_id: tenantP, user_id: y().id, role: "member" });
  if (join.error) throw new Error(`adding Y to tenant P failed: ${join.error.message}`);

  [docP, docF, docU, docV, docW, docD] = await Promise.all([
    uploadDocument(x(), tenantP, "p.pdf"),
    uploadDocument(x(), tenantF, "f.pdf"),
    uploadDocument(x(), tenantU, "u.pdf"),
    uploadDocument(x(), tenantV, "v.pdf"),
    uploadDocument(x(), tenantW, "w.pdf"),
    uploadDocument(x(), tenantD, "d.pdf"),
  ]);
  docsQ = await Promise.all(
    Array.from({ length: EXTRACTION_LIMITS.hourlyRunLimit + 1 }, (_, i) => uploadDocument(x(), tenantQ, `q${i}.pdf`)),
  );

  // nothing may be waiting in the queue: the runner would claim it
  const idle = await runLocalWorker(only(never()));
  if (idle.kind !== "idle") {
    throw new Error(`the test project's extraction queue isn't empty (${idle.kind}); wait for its sweep, about 11 minutes`);
  }
});

afterAll(async () => {
  const problems: string[] = [];
  // end any run a failed test left in flight, at no cost, so its tenant
  // can be deleted
  for (let pass = 0; pass < 20; pass++) {
    const result = await runLocalWorker(only(rejected()));
    if (result.kind !== "delivered") break;
  }
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
    // runs and fields cascade with the tenant; the ledger keeps the spend
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
    // what an abandoned run is charged, and a run in flight holds
    expect(data!.max_calls_per_run).toBe(EXTRACTION_LIMITS.maxCallsPerRun);
    expect(data!.max_output_tokens_per_call).toBe(EXTRACTION_LIMITS.maxOutputTokensPerCall);
    expect(data!.max_input_tokens_per_call).toBe(EXTRACTION_LIMITS.maxInputTokensPerCall);
    expect(data!.prompt_input_tokens).toBe(EXTRACTION_LIMITS.promptInputTokens);
    expect(data!.input_tokens_per_page).toBe(EXTRACTION_LIMITS.inputTokensPerPage);
    expect(data!.retry_input_tokens).toBe(EXTRACTION_LIMITS.retryInputTokens);
    expect(data!.max_pages_per_document).toBe(EXTRACTION_LIMITS.maxPagesPerDocument);
    expect(data!.abandoned_run_price_model).toBe(EXTRACTION_LIMITS.abandonedRunPriceModel);
    // how long a claimed message stays invisible (20260925000002)
    expect(data!.worker_visibility_seconds).toBe(EXTRACTION_LIMITS.workerVisibilitySeconds);
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
});

describe("enqueue", () => {
  let queued: string;

  it("a member cannot enqueue; anon cannot either", async () => {
    const asMember = await enqueue(y(), docP.id);
    expect(asMember.data).toBeNull();
    expect(asMember.error?.code).toBe("42501");
    const anon = await newClient().rpc("enqueue_extraction_run", { p_document_id: docP.id, p_page_count: 1 });
    expect(anon.error?.code).toBe("42501");
    expect((await readDocument(x(), docP.id))?.status).toBe("pending");
  });

  it("an admin's enqueue queues the run with no token and marks the document processing; a second is refused", async () => {
    const { data, error } = await enqueue(x(), docP.id);
    expect(error).toBeNull();
    // the run's id and nothing else: no token reaches the caller
    expect(data).toMatch(/^[0-9a-f-]{36}$/);
    queued = data as string;

    expect((await readDocument(x(), docP.id))?.status).toBe("processing");
    const run = await readRun(x(), queued);
    expect(run).toMatchObject({ status: "queued", document_id: docP.id, page_count: 1, claimed_at: null, finished_at: null, cost_usd: null });

    const again = await enqueue(x(), docP.id);
    expect(again.error?.code).toBe("55000");
    expect(again.error?.message).toMatch(/already running/);
  });

  it("a member sees the run queued, then running, then ended, with the document's gated fields", async () => {
    expect((await readRun(y(), queued))?.status).toBe("queued");

    // a provider that waits, so the claimed run can be seen while it runs
    let called!: () => void;
    const calling = new Promise<void>((resolve) => (called = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const waiting: ExtractionProvider = {
      name: "openai",
      model: NANO,
      async countInputTokens() {
        return 1000;
      },
      async extract() {
        called();
        await released;
        return answer(
          validJson({
            title: { value: "Invoice 42", confidence: 0.99 },
            total_amount: { value: "10.00", confidence: 0.7 },
            due_date: { value: "2026-10-01", confidence: 0.2 },
          }),
          NANO_SNAPSHOT,
          1000,
          100,
        );
      },
    };
    const working = deliver(queued, only(waiting));
    await calling;
    const running = await readRun(y(), queued);
    expect(running).toMatchObject({ status: "running", finished_at: null });
    expect(running?.claimed_at).not.toBeNull();
    release();
    const result = await working;
    expect(result.recorded?.status).toBe("succeeded");

    const run = await readRun(y(), queued);
    expect(run).toMatchObject({ status: "succeeded", provider: "openai", model: NANO_SNAPSHOT, attempts: 1, input_tokens: 1000, output_tokens: 100 });
    // priced by the snapshot's prefix, gpt-5-nano
    expect(Number(run?.cost_usd)).toBe(computeCostUsd(NANO, 1000, 100));
    expect(run?.finished_at).not.toBeNull();

    expect((await readDocument(y(), docP.id))?.status).toBe("needs_review");
    const fields = await readFields(y(), docP.id);
    expect(fields).toHaveLength(FIELD_NAMES.length);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.title).toMatchObject({ value: "Invoice 42", band: "high", clarifying_question: null, run_id: queued });
    expect(byName.total_amount.band).toBe("medium");
    expect(byName.total_amount.clarifying_question).toMatch(/10\.00/);
    expect(byName.due_date).toMatchObject({ value: "2026-10-01", band: "low" });
  });

  it("a later run replaces the fields and can mark the document extracted", async () => {
    const second = await mustEnqueue(x(), docP.id);
    await deliver(second, only(valid({ title: { value: "Invoice 43", confidence: 0.95 } })));
    expect((await readDocument(x(), docP.id))?.status).toBe("extracted");
    const fields = await readFields(x(), docP.id);
    expect(fields).toHaveLength(FIELD_NAMES.length);
    expect(fields.every((f) => f.run_id === second)).toBe(true);
    expect(fields.find((f) => f.name === "title")).toMatchObject({ value: "Invoice 43", band: "high" });
  });

  it("a second runner pass after a finish does nothing, and an empty queue is idle", async () => {
    const provider = never();
    expect((await runLocalWorker(only(provider))).kind).toBe("idle");
    expect((await runLocalWorker(only(provider))).kind).toBe("idle");
    expect(provider.requests).toHaveLength(0);
  });

  it("the page count sent with the enqueue is stored on the run, clamped", async () => {
    for (const [sent, stored] of [
      [250, EXTRACTION_LIMITS.maxPagesPerDocument],
      [0, 1],
      [null, null],
    ] as const) {
      const id = await mustEnqueue(x(), docW.id, sent);
      expect((await readRun(x(), id))?.page_count, `sent ${sent}`).toBe(stored);
      // ended at no cost: a count other than the file's never reaches a
      // model, and the one-page count that matches gets a refused call
      await deliver(id, only(rejected()));
      expect((await readRun(x(), id))?.status).toBe("failed");
    }
    expect((await readDocument(x(), docW.id))?.status).toBe("pending");
  });
});

describe("the worker's own functions", () => {
  it("no signed-in user, and not anon, can claim or finish a run", async () => {
    const finishParams = toFinishParams(randomUUID(), randomUUID(), {
      status: "failed",
      error: "forged",
      rawResponse: null,
      provider: null,
      model: null,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 1,
    } as RunOutcome, false);
    for (const [label, client] of [
      ["an owner", x().client],
      ["a member", y().client],
      ["anon", newClient()],
    ] as const) {
      const claim = await client.rpc("claim_extraction_run");
      expect(claim.error?.code, label).toBe("42501");
      const finish = await client.rpc("finish_extraction_run", finishParams);
      expect(finish.error?.code, label).toBe("42501");
    }
  });

  it("private, pgmq and net aren't reachable over the API, and neither are the queue's helpers", async () => {
    for (const [schema, table] of [
      ["private", "extraction_spend"],
      ["pgmq", "q_extraction"],
      ["net", "http_request_queue"],
    ] as const) {
      const { data, error } = await x().client.schema(schema).from(table).select("*").limit(1);
      expect(data, schema).toBeNull();
      expect(error?.code, schema).toBe("PGRST106");
    }
    const read = await x().client.schema("pgmq").rpc("read", { queue_name: "extraction", vt: 0, qty: 1 });
    expect(read.error?.code).toBe("PGRST106");
    for (const fn of [
      "sweep_extraction_queue",
      "wake_extraction_worker",
      "reap_extraction_run",
      "lock_extraction_run",
      "check_extraction_limits",
    ]) {
      const { error } = await x().client.rpc(fn);
      expect(error?.code, fn).toBe("PGRST202");
    }
  });
});

describe("runs the worker delivers", () => {
  it("a provider that fails ends the run and restores the document", async () => {
    const id = await mustEnqueue(x(), docF.id);
    const provider = rejected();
    await deliver(id, only(provider));
    expect(provider.requests).toHaveLength(1);
    const run = await readRun(x(), id);
    expect(run).toMatchObject({ status: "failed", provider: "openai", attempts: 1, input_tokens: 0, output_tokens: 0 });
    expect(Number(run?.cost_usd)).toBe(0);
    expect(classifyRunError(run?.error)).toBe("extraction.provider_rejected");
    expect((await readDocument(x(), docF.id))?.status).toBe("pending");
    expect(await readFields(x(), docF.id)).toEqual([]);
  });

  it("a timeout falls back once: two calls, the timed-out one charged its measured input with the count's margin and the output cap", async () => {
    const id = await mustEnqueue(x(), docF.id);
    // both at gpt-5-nano's price, to keep the suite under its budget: a
    // timed-out call counts at its most (run.ts), 2 048 tokens out
    const primary = fakeProvider("openai", NANO, [new ProviderError("openai", "transport", "request timed out")], [1200]);
    const fallback = valid();
    await deliver(id, { primary, fallback });
    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    const run = await readRun(x(), id);
    expect(run).toMatchObject({
      status: "succeeded",
      provider: "openai",
      attempts: 2,
      input_tokens: withCountMargin(1200) + 1000,
      output_tokens: MAX_OUTPUT_TOKENS + 100,
    });
    expect(Number(run?.cost_usd)).toBe(computeCostUsd(NANO, withCountMargin(1200) + 1000, MAX_OUTPUT_TOKENS + 100));
    expect((await readDocument(x(), docF.id))?.status).toBe("extracted");
  });

  it("a model with no price is finished at the dearest price on file, marked estimated", async () => {
    const id = await mustEnqueue(x(), docU.id);
    const provider = fakeProvider("anthropic", "claude-sonnet-5", [answer(validJson(), "claude-unpriced-9", 100, 10)]);
    const result = await deliver(id, only(provider));
    expect(provider.requests).toHaveLength(1);
    // the success, then the same usage as a failure, both refused; then the
    // estimate, accepted
    expect(result.finishCalls).toBe(3);
    const dearest = dearestModelFor(100, 10);
    const run = await readRun(x(), id);
    expect(run).toMatchObject({ status: "failed", provider: PRICING[dearest].provider, model: dearest, input_tokens: 100, output_tokens: 10 });
    expect(Number(run?.cost_usd)).toBe(computeCostUsd(dearest, 100, 10));
    expect(isCostEstimated(run?.error)).toBe(true);
    expect(classifyRunError(run?.error)).toBe("extraction.result_not_saved");
    expect((await readDocument(x(), docU.id))?.status).toBe("pending");
    expect(await readFields(x(), docU.id)).toEqual([]);
  });

  it("a forged page count never reaches a model: failed at 0 USD with no call", async () => {
    const id = await mustEnqueue(x(), docV.id, 3);
    const provider = never();
    await deliver(id, only(provider));
    expect(provider.requests).toHaveLength(0);
    const run = await readRun(x(), id);
    expect(run).toMatchObject({ status: "failed", provider: null, model: null, attempts: 0 });
    expect(Number(run?.cost_usd)).toBe(0);
    expect(classifyRunError(run?.error)).toBe("extraction.page_count_mismatch");
    expect((await readDocument(x(), docV.id))?.status).toBe("pending");
  });

  it("bytes that aren't what their type says never reach a model: failed at 0 USD with no call", async () => {
    const fake = await uploadDocument(x(), tenantV, "not-a-pdf.pdf", new TextEncoder().encode("plain text, not a PDF at all"));
    const id = await mustEnqueue(x(), fake.id, 1);
    const provider = never();
    await deliver(id, only(provider));
    expect(provider.requests).toHaveLength(0);
    const run = await readRun(x(), id);
    expect(run).toMatchObject({ status: "failed", model: null, attempts: 0 });
    expect(Number(run?.cost_usd)).toBe(0);
    expect(classifyRunError(run?.error)).toBe("extraction.file_type_mismatch");
  });

  it("replays a recorded fixture end to end: invoice-usd.pdf with its OpenAI answers", async () => {
    const fixture = FIXTURES.find((f) => f.id === "invoice-usd");
    if (!fixture) throw new Error("no invoice-usd fixture");
    const bytes = committedPdf(fixture);
    const pages = await countPages(bytes, "application/pdf");
    const doc = await uploadDocument(x(), tenantR, "invoice-usd.pdf", bytes);
    const id = await mustEnqueue(x(), doc.id, pages);

    const recording = loadRecording(fixture, "openai");
    const replay = replayProvider(recording);
    const result = await deliver(id, only(replay));
    replay.assertComplete();
    expect(result.recorded?.status).toBe("succeeded");

    const run = await readRun(x(), id);
    expect(run?.status).toBe("succeeded");
    expect(run?.attempts).toBe(recording.calls.length);
    expect(Number(run?.cost_usd)).toBe(computeCostUsd(run!.model!, run!.input_tokens!, run!.output_tokens!));
    const fields = await readFields(x(), doc.id);
    expect(fields).toHaveLength(FIELD_NAMES.length);
    // what the replay produced is what the database holds
    if (result.outcome.status !== "succeeded") throw new Error("the replay did not succeed");
    for (const field of result.outcome.fields) {
      expect(fields.find((f) => f.name === field.name), field.name).toMatchObject({ value: field.value, band: field.band });
    }
  });
});

describe("limits and deletion", () => {
  it("the hourly limit refuses the sixth enqueue, with five one-page runs in flight under the ceiling", async () => {
    const limit = EXTRACTION_LIMITS.hourlyRunLimit;
    const ids: string[] = [];
    for (const doc of docsQ.slice(0, limit)) ids.push(await mustEnqueue(x(), doc.id));
    const refused = await enqueue(x(), docsQ[limit].id);
    expect(refused.data).toBeNull();
    expect(refused.error?.code).toBe("54000");
    expect(refused.error?.message).toMatch(new RegExp(`${limit} extraction runs per hour`));
    expect((await readDocument(x(), docsQ[limit].id))?.status).toBe("pending");

    // end them at no cost, oldest first as the queue hands them out
    for (const id of ids) await deliver(id, only(rejected()));
    const runs = await x().client.from("extraction_runs").select("status").eq("tenant_id", tenantQ);
    expect(runs.data?.map((r) => r.status)).toEqual(Array(limit).fill("failed"));
  });

  it("delete_tenant is refused while a run is queued, and goes through once it has ended", async () => {
    const id = await mustEnqueue(x(), docD.id);
    const refused = await x().client.rpc("delete_tenant", { p_tenant_id: tenantD });
    expect(refused.error?.code).toBe("55000");
    expect(refused.error?.message).toMatch(/an extraction is in progress/);

    await deliver(id, only(rejected()));
    const removed = await x().client.storage.from(BUCKET).remove([docD.storage_path]);
    expect(removed.error).toBeNull();
    const deleted = await x().client.rpc("delete_tenant", { p_tenant_id: tenantD });
    expect(deleted.error).toBeNull();
    tenants.splice(tenants.indexOf(tenantD), 1);
  });
});

describe("guards", () => {
  const APP_URL = `https://${APP_PROJECT_REF}.supabase.co`;
  const TEST_URL = `https://${TEST_PROJECT_REF}.supabase.co`;

  // The worker run against `target` under `nodeEnv` with fetch stubbed:
  // what it returned, how many requests it tried, how many provider calls it
  // made, and the error codes it logged.
  async function workerAgainst(target: string, nodeEnv: string) {
    const requests = vi.fn(async () => new Response("{}", { status: 500 }));
    const codes: unknown[] = [];
    vi.stubGlobal("fetch", requests);
    const restoreSink = setLogSink((line) => codes.push(JSON.parse(line).fields?.error_code));
    try {
      const provider = never();
      const result = await runWorkerPointedAt(target, only(provider), nodeEnv);
      return { kind: result.kind, requests: requests.mock.calls.length, providerCalls: provider.requests.length, codes };
    } finally {
      restoreSink();
      vi.unstubAllGlobals();
    }
  }

  it.each([
    ["the app's project under test", APP_URL, "test"],
    ["the test project in production", TEST_URL, "production"],
    ["a lookalike host", `${TEST_URL}.evil.example`, "test"],
    ["a lookalike host, in production", `${APP_URL}.evil.example`, "production"],
    ["http", `http://${TEST_PROJECT_REF}.supabase.co`, "test"],
    ["a port", `${TEST_URL}:8443`, "test"],
    ["a path", `${TEST_URL}/rest/v1`, "test"],
    ["a URL with credentials", `https://user:pass@${TEST_PROJECT_REF}.supabase.co`, "test"],
    ["development mode, the test project", TEST_URL, "development"],
    ["development mode, the app's project", APP_URL, "development"],
  ])("the worker refuses %s before any request", async (_label, target, nodeEnv) => {
    const run = await workerAgainst(target, nodeEnv);
    expect(run).toEqual({ kind: "not_configured", requests: 0, providerCalls: 0, codes: ["worker_target_refused"] });
  });

  it("the same harness sees a request when the URL is right: the stub would catch one", async () => {
    const run = await workerAgainst(TEST_URL, "test");
    expect(run.kind).toBe("claim_failed");
    expect(run.requests).toBeGreaterThan(0);
    expect(run.providerCalls).toBe(0);
  });

  it("neither a member nor the owner can read a run's queue message id, or every column at once", async () => {
    for (const [label, user] of [
      ["the owner", x()],
      ["a member", y()],
    ] as const) {
      const msg = await user.client.from("extraction_runs").select("id, queue_msg_id").eq("tenant_id", tenantP);
      expect(msg.data, label).toBeNull();
      expect(msg.error?.code, label).toBe("42501");
      const star = await user.client.from("extraction_runs").select("*").eq("tenant_id", tenantP);
      expect(star.error?.code, label).toBe("42501");
      // every other column is still theirs to read
      const rest = await user.client.from("extraction_runs").select(RUN_COLUMNS).eq("tenant_id", tenantP);
      expect(rest.error, label).toBeNull();
      expect(rest.data?.length, label).toBeGreaterThan(0);
    }
  });

  it("a member reads only their tenant's runs and fields; other tenants' come back empty", async () => {
    const own = await y().client.from("extraction_runs").select("tenant_id");
    expect(own.error).toBeNull();
    expect(own.data!.length).toBeGreaterThan(0);
    expect(new Set(own.data!.map((r) => r.tenant_id))).toEqual(new Set([tenantP]));
    for (const tenant of [tenantF, tenantQ, tenantR]) {
      const runs = await y().client.from("extraction_runs").select("id").eq("tenant_id", tenant);
      expect(runs.data).toEqual([]);
    }
    const fields = await y().client.from("extracted_fields").select("name").neq("document_id", docP.id);
    expect(fields.data).toEqual([]);
  });

  it("nobody can write runs or fields directly, or change the limits or prices", async () => {
    const insertRun = await x().client.from("extraction_runs").insert({ tenant_id: tenantP, document_id: docP.id, previous_document_status: "pending" });
    expect(insertRun.error?.code).toBe("42501");
    const updateRun = await x().client.from("extraction_runs").update({ cost_usd: 0 }).eq("tenant_id", tenantP);
    expect(updateRun.error?.code).toBe("42501");
    const deleteRun = await x().client.from("extraction_runs").delete().eq("tenant_id", tenantP);
    expect(deleteRun.error?.code).toBe("42501");
    const deleteFields = await x().client.from("extracted_fields").delete().eq("document_id", docP.id);
    expect(deleteFields.error?.code).toBe("42501");
    const updateLimits = await x().client.from("extraction_limits").update({ hourly_run_limit: 1000 }).eq("singleton", true);
    expect(updateLimits.error?.code).toBe("42501");
    const updatePrices = await x().client.from("extraction_model_prices").update({ input_usd_per_million: 0 }).eq("model", NANO);
    expect(updatePrices.error?.code).toBe("42501");
  });

  it("anon is refused everywhere", async () => {
    const anon = newClient();
    for (const table of ["extraction_runs", "extracted_fields", "extraction_limits", "extraction_model_prices"]) {
      const { data, error } = await anon.from(table).select("*").limit(1);
      expect(data, table).toBeNull();
      expect(error?.code, table).toBe("42501");
    }
  });
});

describe("spend", () => {
  it("every run the suite made has ended, and together they cost under 0.01 USD", async () => {
    const { data, error } = await x().client.from("extraction_runs").select("status, cost_usd").in("tenant_id", tenants);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(10);
    expect(data!.filter((run) => run.status === "queued" || run.status === "running")).toEqual([]);
    const spent = data!.reduce((sum, run) => sum + Number(run.cost_usd ?? 0), 0);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(SUITE_BUDGET_USD);
  });
});
