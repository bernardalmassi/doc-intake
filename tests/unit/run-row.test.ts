// The organization page reads each run's stored error, which any admin can
// set to any text by closing a run over the API, and turns it into a code
// before any component sees the row. These tests hold that boundary: what
// leaves toRunRow carries a code from the catalog and nothing of the text.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { runFailureSentence, UNKNOWN_RUN_FAILURE } from "@/app/app/[slug]/messages";
import { RunHistory, runHistoryMeta } from "@/app/app/[slug]/run-history";
import { type RunRecord, toRunRow } from "@/app/app/[slug]/types";
import { isErrorCode, RUN_ERROR_MARKERS, userFacingError } from "@/lib/errors";

const base: RunRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  document_id: "22222222-2222-4222-8222-222222222222",
  status: "failed",
  provider: null,
  model: null,
  attempts: 0,
  input_tokens: null,
  output_tokens: null,
  cost_usd: null,
  latency_ms: null,
  error: null,
  started_at: "2026-09-18T09:00:00.000Z",
};

describe("toRunRow", () => {
  it("drops the stored text and keeps only a code", () => {
    const planted = "Your account needs re-verification at https://evil.example/login";
    const row = toRunRow({ ...base, error: planted });
    expect(row).not.toHaveProperty("error");
    expect(row.error_code).toBe("unknown");
    expect(JSON.stringify(row)).not.toContain("evil.example");
  });

  it("gives an app-written failure its own code, still without the text", () => {
    const stored = `${RUN_ERROR_MARKERS.downloadFailed}: download.not_found`;
    const row = toRunRow({ ...base, error: stored });
    expect(row.error_code).toBe("extraction.download_failed");
    expect(JSON.stringify(row)).not.toContain(stored);
  });

  it("hides text that starts like an app-written failure", () => {
    const planted = `${RUN_ERROR_MARKERS.typeMismatch}application/pdf) visit https://evil.example`;
    const row = toRunRow({ ...base, error: planted });
    expect(isErrorCode(row.error_code)).toBe(true);
    expect(JSON.stringify(row)).not.toContain("evil.example");
  });

  it("keeps a run without an error as null, and every other field as read", () => {
    const row = toRunRow({ ...base, status: "succeeded", cost_usd: "0.00123000" });
    expect(row.error_code).toBeNull();
    expect(row.cost_usd).toBe("0.00123000");
    expect(row.started_at).toBe(base.started_at);
  });

  it("marks a cost charged at the dearest price as estimated, and nothing else", () => {
    const estimated = toRunRow({
      ...base,
      provider: "anthropic",
      model: "claude-sonnet-5",
      attempts: 1,
      input_tokens: 1000,
      output_tokens: 10,
      cost_usd: "0.00210000",
      error: `${RUN_ERROR_MARKERS.costEstimated} the dearest price on file (22023; served by claude-unpriced-9): the result could not be recorded: 22023`,
    });
    expect(estimated.cost_estimated).toBe(true);
    expect(estimated.error_code).toBe("extraction.result_not_saved");
    expect(JSON.stringify(estimated)).not.toContain("claude-unpriced-9");

    expect(toRunRow({ ...base, status: "succeeded", cost_usd: "0.00123000" }).cost_estimated).toBe(false);
    // the marker anywhere but the start doesn't count
    const inside = `anthropic transport: ${RUN_ERROR_MARKERS.costEstimated} the dearest price on file (22023; served by x): y`;
    expect(toRunRow({ ...base, cost_usd: "0.001", error: inside }).cost_estimated).toBe(false);
    // no cost, nothing to call estimated
    expect(toRunRow({ ...base, error: `${RUN_ERROR_MARKERS.costEstimated} the dearest price on file (22023; served by x): y` }).cost_estimated).toBe(false);
  });
});

describe("runHistoryMeta", () => {
  it("never counts a paid run as free: estimates are named, unrecorded costs are not known", () => {
    const recorded = toRunRow({ ...base, status: "succeeded", attempts: 1, cost_usd: "0.01000000" });
    const estimated = toRunRow({
      ...base,
      attempts: 1,
      cost_usd: "0.02000000",
      error: `${RUN_ERROR_MARKERS.costEstimated} the dearest price on file (22023; served by m): the result could not be recorded: 22023`,
    });
    // closed without its usage by the old fallback: calls made, no cost
    const dropped = toRunRow({ ...base, attempts: 2, error: "the result could not be recorded: 22023" });
    // failed before any call: nothing spent, not "not known"
    const noCall = toRunRow({ ...base, error: `${RUN_ERROR_MARKERS.downloadFailed}: download.not_found` });

    expect(runHistoryMeta([recorded, estimated, dropped, noCall])).toBe("Runs 4 · 3 failed · $0.0300 · 1 estimated · 1 not known");
    expect(runHistoryMeta([recorded, noCall])).toBe("Runs 2 · 1 failed · $0.0100");
    // counts are printed at zero
    expect(runHistoryMeta([recorded])).toBe("Runs 1 · 0 failed · $0.0100");
    expect(runHistoryMeta([dropped])).toBe("Runs 1 · 1 failed · cost not known");
  });
});

describe("runHistoryMeta with an abandoned run", () => {
  it("counts the reaper's estimate as estimated, and an older reaped run as not known", () => {
    const reaped = toRunRow({
      ...base,
      cost_usd: "0.05322000",
      error:
        "cost estimated at claude-haiku-4-5-20251001 prices (abandoned; at most 3 calls of 7500 tokens in and 2048 out, for 1 page): " +
        "abandoned: still running after 10 minutes; failed by a later open",
    });
    expect(reaped.error_code).toBe("extraction.abandoned");
    expect(reaped.cost_estimated).toBe(true);
    // abandoned before the reaper charged anything: not known
    const older = toRunRow({ ...base, error: "abandoned: still running after 10 minutes; failed by a later open" });
    expect(runHistoryMeta([reaped, older])).toBe("Runs 2 · 0 failed · 2 abandoned · $0.0532 · 1 estimated · 1 not known");
    const failed = toRunRow({ ...base, error: `${RUN_ERROR_MARKERS.downloadFailed}: download.not_found` });
    expect(runHistoryMeta([failed, reaped])).toBe("Runs 2 · 1 failed · 1 abandoned · $0.0532 · 1 estimated");
  });
});

describe("an abandoned run's row", () => {
  const row = (run: ReturnType<typeof toRunRow>) =>
    renderToStaticMarkup(createElement(RunHistory, { runs: [run], filename: "a.pdf", overdue: false }))
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");

  // As the stale-run check writes it: no model, calls or tokens, and the
  // estimate from the run's pages.
  const reaped = toRunRow({
    ...base,
    cost_usd: "0.10644000",
    error:
      "cost estimated at claude-sonnet-5 prices (abandoned; at most 3 calls of 7500 tokens in and 2048 out, for 1 page): " +
      "abandoned: still running after 10 minutes; failed by a later open",
  });

  it("reads as abandoned and charged its estimate, not as a failure with no model call", () => {
    const text = row(reaped);
    expect(text).toContain("Abandoned Charged its estimate");
    expect(text).toContain("$0.1064 ( Est. imated)");
    expect(text).toContain("This extraction stopped before it finished and was cancelled.");
    expect(text).not.toContain("Failed");
    expect(text).not.toContain("No model call");
    expect(text).not.toContain("No model answered");
  });

  it("says an older one, ended before estimates, stopped responding and its cost isn't known", () => {
    const text = row(toRunRow({ ...base, error: "abandoned: still running after 10 minutes; failed by a later open" }));
    expect(text).toContain("Abandoned Stopped responding");
    expect(text).toContain("Not known");
    expect(text).not.toContain("No model call");
  });
});

describe("the run table's total", () => {
  const table = (runs: ReturnType<typeof toRunRow>[]) =>
    renderToStaticMarkup(createElement(RunHistory, { runs, filename: "a.pdf", overdue: false }))
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");

  it("says the cost is not known when no run's is, as the summary line does, never $0.0000", () => {
    const running = toRunRow({ ...base, status: "running" });
    const text = table([running]);
    expect(runHistoryMeta([running])).toBe("Runs 1 · 0 failed · cost not known yet");
    expect(text).toContain("Total, 1 run");
    expect(text).toContain("Not known yet");
    expect(text).not.toContain("$0.0000");
    expect(text).not.toContain("Leaves out");
  });

  it("adds up the known costs and names the runs it leaves out", () => {
    const recorded = toRunRow({ ...base, status: "succeeded", attempts: 1, cost_usd: "0.01000000" });
    const running = toRunRow({ ...base, id: "33333333-3333-4333-8333-333333333333", status: "running" });
    const text = table([running, recorded]);
    expect(text).toContain("$0.0100");
    expect(text).toContain("Leaves out 1 run whose cost isn't known.");
  });
});

describe("a failed run's sentence", () => {
  const row = (run: ReturnType<typeof toRunRow>) =>
    renderToStaticMarkup(createElement(RunHistory, { runs: [run], filename: "a.pdf", overdue: false }))
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");

  it("is the catalog's for a known code", () => {
    expect(runFailureSentence("extraction.invalid_answer")).toBe(userFacingError("extraction.invalid_answer").message);
  });

  it("says what failed, never the catalog's unknown alone, when the reason can't be shown or wasn't stored", () => {
    const vague = userFacingError("unknown").message;
    expect(runFailureSentence("unknown")).toBe(`${UNKNOWN_RUN_FAILURE} Please try again.`);
    expect(runFailureSentence(null)).toBe(`${UNKNOWN_RUN_FAILURE} Please try again.`);

    const planted = row(toRunRow({ ...base, attempts: 1, error: "anything nobody anticipated" }));
    expect(planted).toContain("The extraction failed, and this page can't say why.");
    expect(planted).not.toContain(vague);
    // a failed run that stored no error still says so
    expect(row(toRunRow({ ...base, attempts: 1 }))).toContain("The extraction failed, and this page can't say why.");
    // a run that didn't fail gets no sentence
    expect(row(toRunRow({ ...base, status: "succeeded", attempts: 1, cost_usd: "0.001" }))).not.toContain("can't say why");
  });
});

describe("the queue's run states", () => {
  const table = (runs: ReturnType<typeof toRunRow>[], overdue = false) =>
    renderToStaticMarkup(createElement(RunHistory, { runs, filename: "a.pdf", overdue }))
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");

  const queued = toRunRow({ ...base, status: "queued" });
  const claimed = toRunRow({ ...base, status: "running", claimed_at: "2026-09-18T09:00:05.000Z" });
  // as reap_extraction_run writes it: never claimed, charged nothing
  const expired = toRunRow({
    ...base,
    cost_usd: "0.00000000",
    error: "expired: not claimed within 10 minutes; cancelled at no cost",
  });

  it("reads a queued run as queued, with every value still to come", () => {
    const text = table([queued]);
    expect(text).toContain("Queued In progress");
    expect(text).toContain("Not known yet");
    expect(text).not.toContain("Stalled");
    expect(runHistoryMeta([queued])).toBe("Runs 1 · 0 failed · cost not known yet");
  });

  it("reads the latest run in flight past its hard bound as stalled, with nothing still to come", () => {
    for (const run of [queued, claimed]) {
      const text = table([run], true);
      expect(text).toContain("Stalled Stopped responding");
      expect(text).toContain("Not known");
      expect(text).not.toContain("yet");
      expect(runHistoryMeta([run], true)).toBe("Runs 1 · 0 failed · cost not known");
    }
    // before the bound it is still going
    expect(table([claimed])).toContain("Running In progress");
  });

  it("reads a run the database expired as expired and never started, counted apart from failures", () => {
    expect(expired.error_code).toBe("extraction.expired");
    const text = table([expired]);
    expect(text).toContain("Expired Never started");
    expect(text).toContain(userFacingError("extraction.expired").message);
    expect(text).not.toContain("Failed");
    expect(runHistoryMeta([expired])).toMatch(/^Runs 1 · 0 failed · 1 expired · /);
  });
});
