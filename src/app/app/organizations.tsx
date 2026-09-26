import Link from "next/link";
import { OpeningHint } from "@/app/components/pending";
import { linkClass, pageTitleClass } from "@/app/ui";
import { ChevronRightIcon } from "./[slug]/icons";
import { roleAbilities } from "./[slug]/messages";

// Presentational: /app fetches the data and passes it in, the design
// preview passes fixtures. The create form comes in as a slot so this
// file doesn't depend on the Server Action.
//
// The organization page's register, one level up: the title hangs from the
// left edge, and each section sits in the landing's grid, its label in the
// first three columns and its lines in the next eight. An organization is
// one ruled line: its name (the link), its address, and what the reader
// can do in it, in the words the organization page uses under its title.
// No role's name: "Owner" says nothing on an organization of one.

export type Role = "owner" | "admin" | "member";

export type Organization = { id: string; name: string; slug: string; role: Role };

// Case- and accent-insensitive, and "Team 2" before "Team 10".
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

const LIST_HEADING_ID = "organizations-heading";
const CREATE_HEADING_ID = "create-heading";

// What the creator can do in the organization they create: an owner's
// abilities, said as the rows say them.
const CREATOR_CAN = `In the organization you create, you can ${lowerFirst(roleAbilities("owner"))}`;

// The same grid as the organization page's sections.
const sectionClass = "grid grid-cols-1 gap-x-8 lg:grid-cols-12";
const sectionLabelClass = "label lg:col-span-3";
const sectionBodyClass = "mt-3 min-w-0 lg:col-span-8 lg:col-start-4 lg:mt-0";

export function OrganizationsView({
  organizations,
  createForm,
}: {
  organizations: Organization[];
  createForm: React.ReactNode;
}) {
  const sorted = [...organizations].sort(
    (a, b) => collator.compare(a.name, b.name) || collator.compare(a.slug, b.slug),
  );
  const none = sorted.length === 0;

  return (
    <>
      <h1 className={pageTitleClass}>Organizations</h1>

      <section aria-labelledby={LIST_HEADING_ID} className={`mt-10 md:mt-14 ${sectionClass}`}>
        <h2 id={LIST_HEADING_ID} className={sectionLabelClass}>
          Your organizations · {sorted.length}
        </h2>
        <div className={sectionBodyClass}>
          {none ? (
            // Empty is one plain line, as an empty register is on the
            // organization page, then what an organization is.
            <div className="border-y border-ink py-4">
              <p className="max-w-prose">
                No organizations yet. An organization is a shared workspace: its documents, what was extracted from them and its
                monthly extraction budget are seen only by its members.
              </p>
            </div>
          ) : (
            <ul className="border-t border-ink">
              {sorted.map((organization) => (
                <li key={organization.id}>
                  <OrganizationLine organization={organization} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-labelledby={CREATE_HEADING_ID} className={`mt-14 md:mt-20 ${sectionClass}`}>
        <h2 id={CREATE_HEADING_ID} className={sectionLabelClass}>
          New organization
        </h2>
        <div className={sectionBodyClass}>
          {none ? (
            <>
              <p className="max-w-prose pb-4 text-small">{CREATOR_CAN}</p>
              <div className="border-b border-ink">{createForm}</div>
            </>
          ) : (
            // Secondary to the list: a fold of the register, as the fields
            // that were read are on the organization page, and the form's
            // primary button only shows once it is open. A native
            // disclosure, so it works before hydration and stays open when
            // the action returns an error.
            <details className="group border-y border-ink">
              <summary className="flex cursor-pointer list-none flex-col gap-1 py-3 md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-x-4 [&::-webkit-details-marker]:hidden">
                <span className="label inline-flex min-h-6 items-center gap-2">
                  Create
                  <ChevronRightIcon className="group-open:rotate-90" />
                </span>
                <span className="min-w-0 max-w-prose text-small md:pt-0.5">{CREATOR_CAN}</span>
              </summary>
              <div className="ledger-arrive">{createForm}</div>
            </details>
          )}
        </div>
      </section>
    </>
  );
}

// One organization's line. The name is the link, underlined like every
// link, and its ::after covers the line, so the whole line is the target;
// the chevron says so without being a second control. From the click until
// the organization page arrives, "Opening…" follows the name.
function OrganizationLine({ organization }: { organization: Organization }) {
  return (
    <div className="relative border-b border-ink py-4">
      <div className="flex items-start gap-4">
        <h3 className="min-w-0 flex-1">
          <Link
            href={`/app/${organization.slug}`}
            className={`${linkClass} [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-['']`}
          >
            {organization.name}
            <OpeningHint href={`/app/${organization.slug}`} />
          </Link>
        </h3>
        <span aria-hidden="true" className="flex h-7 items-center">
          <ChevronRightIcon />
        </span>
      </div>
      <p className="mt-1 text-small [overflow-wrap:anywhere]">/app/{organization.slug}</p>
      <p className="mt-2 max-w-prose text-small">
        <span className="label mr-2">You can</span>
        {roleAbilities(organization.role)}
      </p>
    </div>
  );
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
