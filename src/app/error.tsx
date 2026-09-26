"use client";

import { useEffect, useRef } from "react";
import { ErrorView } from "./error-view";

// Any page that throws while rendering lands here instead of Next's
// generic error screen: a failed query, the database unreachable. In
// production a Server Component's message is replaced by a generic one and
// a digest, so the page says what the reader can do and shows the digest
// as a reference that matches the server log. The root layout is static
// and can't throw, so there is no global-error.
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    console.error(error);
  }, [error]);

  // The page the reader was on is gone; move focus here so a screen
  // reader announces what replaced it.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return <ErrorView digest={error.digest} onRetry={() => retry()} headingRef={heading} />;
}
