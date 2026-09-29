import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Detail } from "@/app/_landing/detail";
import { Figure } from "@/app/_landing/figure";
import styles from "@/app/_landing/landing.module.css";
import { MAIN_ID } from "@/app/components/site-header";
import { ThemeToggle } from "@/app/components/theme-toggle";
import { getCurrentUser } from "@/lib/auth";
import { HOME_TITLE, REPO_URL, repoLinkLabel, SITE_NAME, SITE_SUMMARY } from "./site";

// The landing page's layout is in its CSS module (DESIGN.md, and
// DESIGN-NOTES.md, "Landing (/)"); its tokens and both faces are the root
// layout's and globals.css's, shared with /app.

// A whole title of its own, which the root layout's template ("%s ·
// doc-intake") would otherwise wrap. The description is the root layout's:
// SITE_SUMMARY, the heading below.
export const metadata: Metadata = {
  title: { absolute: HOME_TITLE },
};

// Every fact here can be checked in the repo, and the copy changes when
// they do: the headline is SITE_SUMMARY cut to one sentence that can be set
// at 140px, in its own words, with the whole sentence kept beside it; the bucket's size and types in the documents migrations, the
// page limit, thresholds, models, timeout and output cap in
// src/lib/extraction/config.ts, the limits in public.extraction_limits
// (mirrored there), and the eval figures in EVALS.md. Non-breaking spaces
// (\u00a0) keep a number with its unit.
const technicalData = [
  {
    term: "Input",
    value: "PDF, PNG or JPEG, up to 10\u00a0MB and 100\u00a0pages",
  },
  {
    term: "Output",
    value:
      "Eleven fields: type, title, sender, recipient, document date, due date, payment terms, reference, total, currency, summary. Each with a confidence and the words it was read from.",
  },
  {
    term: "Confidence",
    value:
      "85% and up: stored as read. From 60% up to 85%: stored with one question for the reviewer. Under 60%: stored, and the document goes to review.",
  },
  {
    term: "Models",
    value: "claude-sonnet-5. gpt-5-nano when Claude times out, can’t be reached or answers with a 5xx.",
  },
  {
    term: "Per call",
    value: "60\u00a0s and 2,048 output tokens at most. One retry when the answer doesn’t fit the schema.",
  },
  {
    term: "Limits",
    value:
      "Checked in SQL before the model is called: 1\u00a0USD per organization per month, 3\u00a0USD a month across all of them, 5\u00a0runs per organization per hour.",
  },
  {
    term: "Eval",
    value:
      "Recorded 18\u00a0Sep\u00a02026 on 12 generated documents. 97 of 99 fields right on the 9 ordinary ones, and no instruction followed from the 3 written to hijack it. 6.1\u00a0s median and 0.0202\u00a0USD mean per run, over all 12.",
  },
];

const construction = [
  {
    term: "Isolation",
    value:
      "The app reaches Postgres only as the signed-in user, with the publishable key and never a service key, so row-level security is the boundary: every table of organization data carries the organization’s id, and its policies decide who sees what.",
  },
  {
    term: "Uploads",
    value:
      "The browser sends each file straight to storage, whose policy accepts it only at the path its database row generated and only from the member who created that row. Its first bytes are checked against its type before any model sees it.",
  },
  {
    term: "Cost",
    value:
      "The database computes each run’s cost from its token counts, at prices in a table nobody can write. The app never passes in a cost.",
  },
  {
    term: "Hostile documents",
    value:
      "A document is data, never instructions: the answer must fit a fixed schema, and a check on every field sends anything that looks like an injected instruction to review.",
  },
];

export default async function Home() {
  if (await getCurrentUser()) redirect("/app");

  return (
    <div className={styles.page}>
      {/* The two ways in sit in the header, where /app keeps its account
          controls, so the first screen holds the headline and one object. */}
      <header className={`${styles.frame} ${styles.header}`}>
        <a href={`#${MAIN_ID}`} className={`${styles.small} ${styles.skip}`}>
          Skip to content
        </a>
        <p className={styles.wordmark}>{SITE_NAME}</p>
        <nav aria-label="Account" className={styles.account}>
          <Link href="/sign-in" className={`${styles.label} ${styles.action}`}>
            Sign in
          </Link>
          <Link href="/sign-up" className={`${styles.label} ${styles.action} ${styles.primary}`}>
            Create an account
          </Link>
        </nav>
        <ThemeToggle className={styles.toggle} />
      </header>

      <main id={MAIN_ID} className={styles.frame}>
        <section className={`${styles.grid} ${styles.hero}`}>
          <h1 className={styles.display}>
            <span>Reads documents,</span> <span>marks unsure fields.</span>
          </h1>
          <Detail />
          <p className={styles.lede}>{SITE_SUMMARY}</p>
        </section>

        <section aria-labelledby="fig-1">
          <Figure />
        </section>

        <Specs id="technical-data" title="Technical data" rows={technicalData} />
        <Specs id="construction" title="Construction" rows={construction} end>
          {REPO_URL && (
            <p className={styles.source}>
              <a href={REPO_URL} className={styles.link}>
                {repoLinkLabel(REPO_URL)}
              </a>
            </p>
          )}
        </Specs>
      </main>
    </div>
  );
}

// A manual's table: the title in the left margin, one ruled row per term.
function Specs({
  id,
  title,
  rows,
  end = false,
  children,
}: {
  id: string;
  title: string;
  rows: { term: string; value: string }[];
  end?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={`${styles.grid} ${styles.section} ${end ? styles.end : ""}`}>
      <h2 id={id} className={`${styles.label} ${styles.margin} ${styles.sectionTitle}`}>
        {title}
      </h2>
      <div className={styles.content}>
        <dl className={styles.specs}>
          {rows.map(({ term, value }) => (
            <div key={term} className={styles.spec}>
              <dt className={styles.label}>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {children}
      </div>
    </section>
  );
}
