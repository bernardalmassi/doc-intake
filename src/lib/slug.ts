// An organization's web address (tenants.slug), derived from its name. One
// module for the create form and the createTenant action, so the address
// the form shows is the one the server tries first.

// tenants.slug check constraint (20260917000001); SLUG_PATTERN in
// src/lib/errors.ts is the whole rule.
export const SLUG_MAX_LENGTH = 48;

// How many addresses createTenant tries for a derived one: the address,
// then -2 up to -20. Other organizations are hidden by RLS, so the only way
// to learn an address is taken is to try it; the cap bounds what one
// submit can cost.
export const MAX_SLUG_ATTEMPTS = 20;

// "Café Müller & Co_Ltd " -> "cafe-muller-co-ltd". Accents are folded
// rather than dropping the letter; anything else outside a-z, 0-9 and the
// hyphen goes, so a name in another script can derive to "". Hyphens are
// trimmed again after the cut, so the address never ends with one.
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
}

// The addresses to try for a derived one, in order: "acme", "acme-2",
// "acme-3" … Each suffix still fits in 48 characters, by cutting the base.
export function slugCandidates(base: string, count = MAX_SLUG_ATTEMPTS): string[] {
  const candidates = [base];
  for (let n = 2; n <= count; n++) {
    const suffix = `-${n}`;
    candidates.push(base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, "") + suffix);
  }
  return candidates;
}

// Tries each address in turn and returns the first answer that isn't
// "taken", or the last answer if every one was. The database's unique
// constraint is what says taken, so two people creating "Acme" at once
// can't both get "acme".
export async function tryEachSlug<R>(
  candidates: readonly string[],
  attempt: (slug: string) => Promise<R>,
  isTaken: (result: R) => boolean,
): Promise<R> {
  if (candidates.length === 0) throw new Error("tryEachSlug needs at least one candidate");
  let result = await attempt(candidates[0]);
  for (const slug of candidates.slice(1)) {
    if (!isTaken(result)) break;
    result = await attempt(slug);
  }
  return result;
}
