import Link from "next/link";
import { linkClass } from "./ui";

// Rendered by notFound(). The tenant page calls it both for a slug that
// doesn't exist and for one the user isn't a member of, so the two cases
// look identical.
export default function NotFound() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="mt-2 text-neutral-400">There is nothing at this address.</p>
      <p className="mt-4">
        <Link href="/app" className={linkClass}>
          Back to your organizations
        </Link>
      </p>
    </main>
  );
}
