// /dev/states' documents read the states their screens promise, computed
// by the page's own buildEntries and documentState at the time of the
// request, so a change to a bound or a rule can't quietly change what a
// screen shows. No database, no network.

import { describe, expect, it } from "vitest";
import { documentState, failedExit } from "@/app/app/[slug]/document-state";
import { extractionsInFlight } from "@/app/app/[slug]/entries";
import {
  entriesFor,
  EXPIRED_ID,
  PREFLIGHT_ID,
  QUEUED_ID,
  QUEUED_OVERDUE_ID,
  RUNNING_ID,
  SHARED_QUESTION_ID,
  STALE_ID,
  TOO_DENSE_ID,
} from "@/app/dev/states/fixtures";

const one = (id: string) => entriesFor([id])[0];

describe("the /dev/states fixtures", () => {
  it("read queued and running from their runs, and keep the page polling", () => {
    expect(documentState(one(QUEUED_ID))).toBe("queued");
    expect(documentState(one(RUNNING_ID))).toBe("running");
    expect(extractionsInFlight(entriesFor([QUEUED_ID]))).toBe(true);
  });

  it("read both overdue runs as failed with Extract again, and poll for neither", () => {
    for (const id of [STALE_ID, QUEUED_OVERDUE_ID]) {
      const entry = one(id);
      expect(entry.overdue, id).toBe(true);
      expect(documentState(entry), id).toBe("failed");
      expect(failedExit(entry), id).toBe("extract");
    }
    expect(extractionsInFlight(entriesFor([STALE_ID, QUEUED_OVERDUE_ID]))).toBe(false);
  });

  it("read expired and the 0 USD preflight failure as failed with Extract again, and too dense with Delete", () => {
    expect(one(EXPIRED_ID).runs[0].error_code).toBe("extraction.expired");
    expect(failedExit(one(EXPIRED_ID))).toBe("extract");
    expect(Number(one(PREFLIGHT_ID).runs[0].cost_usd)).toBe(0);
    expect(failedExit(one(PREFLIGHT_ID))).toBe("extract");
    expect(one(TOO_DENSE_ID).runs[0].error_code).toBe("extraction.too_dense");
    expect(failedExit(one(TOO_DENSE_ID))).toBe("delete");
  });

  it("give the shared-question invoice three Low fields, two asking the same question", () => {
    const low = one(SHARED_QUESTION_ID).fields.filter((field) => field.band === "low");
    expect(low.map((field) => field.name)).toEqual(["document_date", "due_date", "total_amount"]);
    expect(low[0].clarifying_question).toBe(low[1].clarifying_question);
    expect(low[2].clarifying_question).not.toBe(low[0].clarifying_question);
  });
});
