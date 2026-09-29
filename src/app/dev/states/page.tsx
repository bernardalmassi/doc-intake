import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MAIN_ID, SiteHeader } from "@/app/components/site-header";
import { hintClass, linkClass, pageClass, pageTitleClass, sectionTitleClass } from "@/app/ui";
import { SCREENS } from "./screens";

// Development only: every screen and state of the signed-in app and the
// auth pages, rendered from static rows (fixtures.ts) with stand-ins for
// Server Actions and Supabase, so each can be seen and captured without an
// account. /dev/states lists the screens; /dev/states?screen=<id> renders
// one exactly as its route does. A production build answers 404.

// The metadata answers 404 too: a static `metadata` export would still ship
// "States" in the production 404's payload, and the tab would take that
// title after hydration instead of the not-found page's.
export function generateMetadata(): Metadata {
  if (process.env.NODE_ENV === "production") notFound();
  return { title: "States", robots: { index: false, follow: false } };
}

export default async function StatesPage({ searchParams }: PageProps<"/dev/states">) {
  if (process.env.NODE_ENV === "production") notFound();

  const { screen } = await searchParams;
  if (typeof screen === "string") {
    const found = SCREENS.find((s) => s.id === screen);
    if (!found) notFound();
    return found.render();
  }

  const groups = [...new Set(SCREENS.map((s) => s.group))];
  return (
    <>
      <SiteHeader />
      <main id={MAIN_ID} className={pageClass}>
        <h1 className={pageTitleClass}>States</h1>
        <p className={`mt-2 max-w-prose ${hintClass}`}>
          Every screen of the app from static data. Nothing here signs in or reaches a database. Development only.
        </p>
        {groups.map((group) => (
          <section key={group} className="mt-8">
            <h2 className={sectionTitleClass}>{group}</h2>
            <ul className="mt-2 space-y-1">
              {SCREENS.filter((s) => s.group === group).map((s) => (
                <li key={s.id}>
                  <Link href={`/dev/states?screen=${s.id}`} className={linkClass}>
                    {s.id}
                  </Link>{" "}
                  <span className={hintClass}>{s.title}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
    </>
  );
}
