import Link from "next/link";
import { redirect } from "next/navigation";
import { MAIN_ID, SiteHeader } from "@/app/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { REPO_URL, repoLinkLabel, SITE_SUMMARY } from "./site";
import {
  buttonClass,
  linkClass,
  pageClass,
  pageTitleClass,
  secondaryButtonClass,
  sectionTitleClass,
  textTargetClass,
} from "./ui";


// No metadata of its own: the root layout's default title (the app's name)
// and description (SITE_SUMMARY, the heading below) are this page's.

// One sentence each, and every fact in them can be checked in the repo:
// the limits in public.extraction_limits (mirrored in
// src/lib/extraction/config.ts), the models in config.ts, the storage
// policy in the documents migrations. Change the copy when those change.
// Non-breaking spaces (\u00a0) keep a number with its unit and a product
// with its version.
const architecture = [
  {
    term: "Isolation",
    sentence:
      "The Next.js\u00a016 app reaches Supabase Postgres only as the signed-in user, with the publishable key and never a service role, so row-level security is the boundary: every table of organization data carries the organization’s id, and its policies decide who sees what.",
  },
  {
    term: "Uploads",
    sentence:
      "Files go from the browser straight to Supabase Storage, whose policy accepts one only at the path its database row generated and only from the member who created that row, and the file’s magic bytes are checked before any model sees it.",
  },
  {
    term: "Extraction",
    sentence:
      "Before any model is called, SQL enforces the spend limits (1\u00a0USD per organization and 3\u00a0USD overall each month, 5\u00a0runs per organization per hour), then Claude Haiku\u00a04.5 returns ten schema-validated fields, with GPT-5\u00a0nano as the fallback, and the database computes the cost from token counts instead of trusting the app.",
  },
];

export default async function Home() {
  if (await getCurrentUser()) redirect("/app");

  return (
    <>
      <SiteHeader />
      <main id={MAIN_ID} className={pageClass}>
        <div className="max-w-3xl sm:pt-6">
          <h1 className={`${pageTitleClass} max-w-2xl text-balance`}>{SITE_SUMMARY}</h1>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/sign-up" className={buttonClass}>
              Create an account
            </Link>
            <Link href="/sign-in" className={secondaryButtonClass}>
              Sign in
            </Link>
          </div>

          <section aria-labelledby="how-its-built" className="mt-16 sm:mt-20">
            <h2 id="how-its-built" className={sectionTitleClass}>
              How it’s built
            </h2>
            <dl className="mt-4 border-t border-line">
              {architecture.map(({ term, sentence }) => (
                <div
                  key={term}
                  className="grid gap-1 border-b border-line py-4 sm:grid-cols-[8rem_1fr] sm:gap-6"
                >
                  <dt className="text-sm font-medium text-muted sm:leading-6">{term}</dt>
                  <dd>{sentence}</dd>
                </div>
              ))}
            </dl>
            {REPO_URL && (
              <p className="mt-6">
                <a href={REPO_URL} className={`${linkClass} ${textTargetClass} inline-block`}>
                  {repoLinkLabel(REPO_URL)}
                </a>
              </p>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
