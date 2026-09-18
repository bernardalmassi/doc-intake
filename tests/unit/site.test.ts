// The landing page links to the source only when NEXT_PUBLIC_REPO_URL is a
// real http or https URL, so a private repository never gets a dead link.

import { describe, expect, it } from "vitest";
import { parseRepoUrl, repoLinkLabel } from "@/app/site";

describe("parseRepoUrl", () => {
  it("gives no link when the variable is unset or blank", () => {
    expect(parseRepoUrl(undefined)).toBeNull();
    expect(parseRepoUrl("")).toBeNull();
    expect(parseRepoUrl("   ")).toBeNull();
  });

  it("accepts an http or https URL, trimmed", () => {
    expect(parseRepoUrl(" https://github.com/owner/repo ")).toBe("https://github.com/owner/repo");
    expect(parseRepoUrl("http://git.example.com/repo")).toBe("http://git.example.com/repo");
  });

  it("refuses anything that isn't an http or https URL", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,hi", "github.com/owner/repo", "ftp://example.com/r"]) {
      expect(parseRepoUrl(value), value).toBeNull();
    }
  });
});

describe("repoLinkLabel", () => {
  it("names GitHub only when the link goes there", () => {
    expect(repoLinkLabel("https://github.com/owner/repo")).toBe("Source and tests on GitHub");
    expect(repoLinkLabel("https://gitlab.com/owner/repo")).toBe("Source and tests");
  });
});
