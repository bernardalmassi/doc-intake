import Link from "next/link";
import { hintClass, pageTitleClass, panelClass, secondaryButtonClass } from "@/app/ui";

// Presentational: /app fetches the data and passes it in, the design
// preview passes fixtures. The create form comes in as a slot so this
// file doesn't depend on the Server Action.

export type Role = "owner" | "admin" | "member";

export type Organization = { id: string; name: string; slug: string; role: Role };

const roleLabels: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

// Case- and accent-insensitive, and "Team 2" before "Team 10".
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function OrganizationsView({
  organizations,
  createForm,
}: {
  organizations: Organization[];
  createForm: React.ReactNode;
}) {
  if (organizations.length === 0) return <NoOrganizations createForm={createForm} />;

  const sorted = [...organizations].sort(
    (a, b) => collator.compare(a.name, b.name) || collator.compare(a.slug, b.slug),
  );

  return (
    <>
      <h1 className={pageTitleClass}>Organizations</h1>
      <p className="mt-2 text-muted">Open an organization to upload and review its documents.</p>

      <ul className="mt-6 max-w-2xl space-y-2">
        {sorted.map((organization) => (
          <li key={organization.id}>
            <OrganizationLink organization={organization} />
          </li>
        ))}
      </ul>

      {/* Secondary to the list: one click away, and the primary button
          only shows once it's open. A native disclosure, so it works
          before hydration and stays open when the action returns an
          error. */}
      <details className="group mt-8 max-w-2xl">
        <summary
          className={`${secondaryButtonClass} list-none [&::-webkit-details-marker]:hidden`}
        >
          Create another organization
          <ChevronDownIcon className="group-open:rotate-180" />
        </summary>
        <div className={`mt-4 max-w-md ${panelClass}`}>
          <p className={hintClass}>You&apos;ll be the owner of the new organization.</p>
          <div className="mt-4">{createForm}</div>
        </div>
      </details>
    </>
  );
}

function NoOrganizations({ createForm }: { createForm: React.ReactNode }) {
  return (
    <>
      <h1 className={pageTitleClass}>Create an organization</h1>
      <p className="mt-3 max-w-2xl text-muted">
        An organization is a shared workspace. Its documents, the details extracted from them and
        its monthly extraction budget are visible only to its members. Whoever creates an
        organization becomes its owner.
      </p>
      <div className={`mt-6 max-w-md ${panelClass}`}>{createForm}</div>
    </>
  );
}

// The whole row is the link. The name is underlined like every other link,
// so the row doesn't rely on its border or color to read as one.
function OrganizationLink({ organization }: { organization: Organization }) {
  return (
    <Link
      href={`/app/${organization.slug}`}
      className="group flex items-center gap-4 rounded-lg border border-line bg-surface px-4 py-3 hover:border-line-strong"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium wrap-anywhere underline decoration-line-strong underline-offset-4 group-hover:decoration-fg">
          {organization.name}
        </span>
        <span className="mt-0.5 block text-sm text-muted wrap-anywhere">
          /app/{organization.slug}
        </span>
      </span>
      <span className="shrink-0 text-sm text-muted">
        <span className="sr-only">Your role: </span>
        {roleLabels[organization.role]}
      </span>
      <ChevronRightIcon />
    </Link>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-muted group-hover:text-fg"
    >
      <path d="M6 3.5L10.5 8L6 12.5" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M3.5 6L8 10.5L12.5 6" />
    </svg>
  );
}
