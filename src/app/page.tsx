import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export default async function Home() {
  if (await getCurrentUser()) redirect("/app");

  return (
    <main className="p-8">
      <h1>doc-intake</h1>
      <p>
        <Link href="/sign-in">Sign in</Link> or <Link href="/sign-up">sign up</Link>
      </p>
    </main>
  );
}
