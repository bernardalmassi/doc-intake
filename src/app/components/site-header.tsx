import Link from "next/link";
import { signOut } from "@/app/auth/actions";
import { containerClass, secondaryButtonClass } from "@/app/ui";
import { ThemeToggle } from "./theme-toggle";

// The id of every page's <main>, which the skip link jumps to.
export const MAIN_ID = "main";

// On every page. Same max width and gutters as the page content. The
// right-hand slot holds whatever the page needs there (the signed-in
// account on /app pages); the theme toggle is always last.
//
// The skip link is the first thing Tab reaches on every page. It sits above
// the top edge until it has focus, then covers the wordmark. A plain <a>,
// not next/link: jumping to #main is the browser's own job, and it works
// before hydration.
export function SiteHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="border-b border-line">
      <div className={`${containerClass} relative flex h-14 items-center justify-between gap-4`}>
        <a
          href={`#${MAIN_ID}`}
          className={`${secondaryButtonClass} absolute top-2.5 left-4 z-10 -translate-y-16 bg-canvas focus:translate-y-0 sm:left-6`}
        >
          Skip to content
        </a>
        <Link href="/" className="shrink-0 text-base font-semibold tracking-tight text-fg">
          doc-intake
        </Link>
        <div className="flex min-w-0 items-center gap-3">
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
      <p className="min-w-0 truncate text-sm text-muted">
        <span className="hidden sm:inline">Signed in as </span>
        {email}
      </p>
      <form action={signOutAction} className="shrink-0">
        <button type="submit" className={secondaryButtonClass}>
          Sign out
        </button>
      </form>
    </>
  );
}
