// The web address helper (src/lib/slug.ts), shared by the create form and
// the createTenant action: deriving an address from a name, and walking
// -2, -3 … when the derived one is taken.

import { describe, expect, it } from "vitest";
import { checkTenantInput, SLUG_PATTERN } from "@/lib/errors";
import { MAX_SLUG_ATTEMPTS, SLUG_MAX_LENGTH, slugCandidates, slugify, tryEachSlug } from "@/lib/slug";

describe("slugify", () => {
  it("lowercases an ordinary name and joins its words with hyphens", () => {
    expect(slugify("Acme Corp")).toBe("acme-corp");
    expect(slugify("Northwind_Traders 2026")).toBe("northwind-traders-2026");
  });

  it("drops punctuation, collapses the hyphens left behind and trims them from the ends", () => {
    expect(slugify("Smith & Sons, Ltd.")).toBe("smith-sons-ltd");
    expect(slugify("--Acme -- Corp--")).toBe("acme-corp");
  });

  it("derives nothing from a name that is punctuation only, and the action refuses it", () => {
    expect(slugify("!!! ??? ...")).toBe("");
    expect(slugify("&")).toBe("");
    expect(checkTenantInput("!!! ??? ...", slugify("!!! ??? ..."))).toBe("tenant.slug_invalid");
  });

  it("derives nothing from a Cyrillic name, and the action refuses it", () => {
    expect(slugify("Рога и копыта")).toBe("");
    expect(checkTenantInput("Рога и копыта", slugify("Рога и копыта"))).toBe("tenant.slug_invalid");
  });

  it("keeps a too-short result too short rather than padding it", () => {
    expect(slugify("A!")).toBe("a");
    expect(slugify("Ян 7")).toBe("7");
    expect(checkTenantInput("A!", slugify("A!"))).toBe("tenant.slug_invalid");
  });

  it("folds accents rather than dropping the letter", () => {
    expect(slugify("Café Müller & Co")).toBe("cafe-muller-co");
  });

  it("cuts a name over 48 characters to 48, never ending on a hyphen", () => {
    const name = "The International Brotherhood of Document Processors and Allied Trades";
    expect(slugify(name)).toBe("the-international-brotherhood-of-document-proces");
    expect(slugify(name)).toHaveLength(SLUG_MAX_LENGTH);
    // a cut that lands just after a word keeps no trailing hyphen
    expect(slugify(`${"a".repeat(47)} bcd`)).toBe("a".repeat(47));
    expect(SLUG_PATTERN.test(slugify(name))).toBe(true);
  });

  it("ignores leading and trailing spaces", () => {
    expect(slugify("Acme   ")).toBe("acme");
    expect(slugify("  Acme Corp \t\n")).toBe("acme-corp");
  });
});

describe("slugCandidates", () => {
  it("tries the address, then -2, -3 … up to the cap", () => {
    const candidates = slugCandidates("acme");
    expect(candidates.slice(0, 3)).toEqual(["acme", "acme-2", "acme-3"]);
    expect(candidates).toHaveLength(MAX_SLUG_ATTEMPTS);
    expect(candidates.at(-1)).toBe(`acme-${MAX_SLUG_ATTEMPTS}`);
  });

  it("cuts a 48 character address to make room for the suffix, without a doubled hyphen", () => {
    const base = slugify(`${"a".repeat(45)} bcd`);
    expect(base).toBe(`${"a".repeat(45)}-bc`);
    const candidates = slugCandidates(base);
    expect(candidates[1]).toBe(`${"a".repeat(45)}-2`);
    expect(candidates[9]).toBe(`${"a".repeat(45)}-10`);
    for (const candidate of candidates) expect(SLUG_PATTERN.test(candidate), candidate).toBe(true);
  });
});

describe("the collision path", () => {
  // A stand-in for create_tenant: refuses a taken address as the unique
  // constraint would, and records every address it was asked for.
  function fakeCreate(taken: Set<string>) {
    const asked: string[] = [];
    const attempt = async (slug: string) => {
      asked.push(slug);
      if (taken.has(slug)) return { code: "tenant.slug_taken" as const };
      taken.add(slug);
      return { slug };
    };
    const isTaken = (result: Awaited<ReturnType<typeof attempt>>) => "code" in result;
    return { asked, attempt, isTaken };
  }

  it("takes the derived address when it is free", async () => {
    const { asked, attempt, isTaken } = fakeCreate(new Set());
    expect(await tryEachSlug(slugCandidates(slugify("Acme")), attempt, isTaken)).toEqual({ slug: "acme" });
    expect(asked).toEqual(["acme"]);
  });

  it("appends -2, -3 … until one is free", async () => {
    const { asked, attempt, isTaken } = fakeCreate(new Set(["acme", "acme-2"]));
    expect(await tryEachSlug(slugCandidates(slugify("Acme")), attempt, isTaken)).toEqual({ slug: "acme-3" });
    expect(asked).toEqual(["acme", "acme-2", "acme-3"]);
  });

  it("gives the same name a new address each time", async () => {
    const taken = new Set<string>();
    const { attempt, isTaken } = fakeCreate(taken);
    const created = [];
    for (let i = 0; i < 3; i++) created.push(await tryEachSlug(slugCandidates(slugify("Acme")), attempt, isTaken));
    expect(created).toEqual([{ slug: "acme" }, { slug: "acme-2" }, { slug: "acme-3" }]);
  });

  it("returns taken once the cap is reached, having tried each address once", async () => {
    const { asked, attempt, isTaken } = fakeCreate(new Set(slugCandidates("acme")));
    expect(await tryEachSlug(slugCandidates("acme"), attempt, isTaken)).toEqual({ code: "tenant.slug_taken" });
    expect(asked).toEqual(slugCandidates("acme"));
  });

  it("tries a typed address once: taken is the answer", async () => {
    const { asked, attempt, isTaken } = fakeCreate(new Set(["acme"]));
    expect(await tryEachSlug(["acme"], attempt, isTaken)).toEqual({ code: "tenant.slug_taken" });
    expect(asked).toEqual(["acme"]);
  });

  it("stops at the first answer that isn't taken, even a failure", async () => {
    const asked: string[] = [];
    const result = await tryEachSlug(
      slugCandidates("acme"),
      async (slug) => {
        asked.push(slug);
        return slug === "acme" ? "taken" : "unavailable";
      },
      (answer) => answer === "taken",
    );
    expect(result).toBe("unavailable");
    expect(asked).toEqual(["acme", "acme-2"]);
  });
});
