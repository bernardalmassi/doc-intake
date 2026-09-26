import Link from "next/link";
import { signOut } from "@/app/auth/actions";
import { containerClass, secondaryButtonClass } from "@/app/ui";
import { SignOutButton } from "./pending";
import { ThemeToggle } from "./theme-toggle";

// The id of every page's <main>, which the skip link jumps to.
export const MAIN_ID = "main";

// On every page. Same max width and gutters as the page content, and the
// landing's header: 64px tall, no rule under it, 1rem between the slot and
// the theme toggle (the landing's column gap). The wordmark is a link to
// the landing, which sends a signed-in visitor on to /app. The right-hand
// slot holds whatever the page needs there (the signed-in account on /app
// pages); the theme toggle is always last.
//
// The skip link is the first thing Tab reaches on every page. It sits above
// the top edge until it has focus, then covers the wordmark. A plain <a>,
// not next/link: jumping to #main is the browser's own job, and it works
// before hydration.
export function SiteHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header>
      <div className={`${containerClass} relative flex h-16 items-center justify-between gap-4`}>
        <a
          href={`#${MAIN_ID}`}
          className={`${secondaryButtonClass} absolute top-3 left-4 z-10 -translate-y-20 bg-paper focus:translate-y-0 md:left-10`}
        >
          Skip to content
        </a>
        <Link href="/" className="wordmark shrink-0 text-ink">
          doc-intake
        </Link>
        <div className="flex min-w-0 items-center gap-4">
          {children}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

// The header slot for a signed-in page: who is signed in, and Sign out.
export function AccountControls({ email }: { email: string | undefined }) {
  return <AccountControlsView email={email} signOutAction={signOut} />;
}

// What AccountControls shows, with the sign-out action passed in, so
// /dev/states can render it with one that does nothing. The email
// truncates rather than pushing the header wider on a phone.
export function AccountControlsView({
  email,
  signOutAction,
}: {
  email: string | undefined;
  signOutAction: () => void | Promise<void>;
}) {
  return (
    <>
      {/* On a phone there is room for Sign out and the theme only; a
          clipped address says nothing, so it waits for a wider screen. */}
      <p className="hidden min-w-0 truncate text-small text-ink sm:block">
        Signed in as {email}
      </p>
      <form action={signOutAction} className="shrink-0">
        <SignOutButton />
      </form>
    </>
  );
}
