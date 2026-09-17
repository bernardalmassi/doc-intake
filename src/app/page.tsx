import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { linkClass } from "./ui";

export default async function Home() {
  if (await getCurrentUser()) redirect("/app");

  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">doc-intake</h1>
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
  );
}
