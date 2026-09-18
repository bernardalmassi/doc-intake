import Link from "next/link";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/app/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { linkClass, pageClass, pageTitleClass } from "./ui";

export default async function Home() {
  if (await getCurrentUser()) redirect("/app");

  return (
    <>
      <SiteHeader />
      <main className={pageClass}>
        <h1 className={pageTitleClass}>doc-intake</h1>
        <p className="mt-4">
          <Link href="/sign-in" className={linkClass}>
            Sign in
          </Link>{" "}
          or{" "}
          <Link href="/sign-up" className={linkClass}>
            sign up
          </Link>
        </p>
      </main>
    </>
  );
}
