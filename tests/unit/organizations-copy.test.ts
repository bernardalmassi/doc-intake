// The organizations list says what the reader can do in each organization,
// in the organization page's words, never the role's bare name ("Owner"
// reads oddly on an organization of one). No database, no network.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { roleAbilities } from "@/app/app/[slug]/messages";
import { type Organization, OrganizationsView } from "@/app/app/organizations";

const organizations: Organization[] = [
  { id: "1", name: "Bramhall Interiors", slug: "bramhall-interiors", role: "owner" },
  { id: "2", name: "Calder Wharf site office", slug: "calder-wharf", role: "admin" },
  { id: "3", name: "Sheffield fit-out archive", slug: "sheffield-archive", role: "member" },
];

function text(list: Organization[]): string {
  const html = renderToStaticMarkup(createElement(OrganizationsView, { organizations: list, createForm: null }));
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

describe("the organizations list", () => {
  it("says what each role allows, and never names the role", () => {
    const page = text(organizations);
    expect(page).toContain(roleAbilities("owner"));
    expect(page).toContain(roleAbilities("member"));
    expect(page).not.toMatch(/\b(Owner|Admin|Member)\b/);
  });

  it("counts the organizations, zero included, and says what an empty one is", () => {
    expect(text(organizations)).toContain("Your organizations · 3");
    const empty = text([]);
    expect(empty).toContain("Your organizations · 0");
    expect(empty).toContain("None yet.");
  });

  it("tells whoever creates one what they can do in it", () => {
    expect(text([])).toContain("In the organization you create, you can upload, extract, download and delete documents");
  });
});
