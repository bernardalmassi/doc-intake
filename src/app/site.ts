// The app's name, and what it does in one line. The line is the landing
// page's heading and every page's meta description; the name ends every
// page's title (the template in the root layout).
export const SITE_NAME = "doc-intake";

export const SITE_SUMMARY =
  "Reads invoices, receipts, contracts and letters into eleven fields, and marks any field it is unsure of for a person to check.";

// Where the source lives, from NEXT_PUBLIC_REPO_URL, which Next inlines at
// build time. The landing page links to it only when this is set: unset,
// blank, or anything but an http or https URL gives null and no link, so a
// deployment of a private repository doesn't send visitors to a 404.
export function parseRepoUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export const REPO_URL = parseRepoUrl(process.env.NEXT_PUBLIC_REPO_URL);

// "Source and tests on GitHub" when it is on GitHub, otherwise without the
// name of a host it may not be on.
export function repoLinkLabel(url: string): string {
  return new URL(url).hostname === "github.com" ? "Source and tests on GitHub" : "Source and tests";
}
