"use client";

// An inline script that runs while the server's HTML is parsed and is inert
// when React renders it in the browser. React warns about <script> tags it
// creates on the client and never runs them, and it does create this one
// when a server error makes it render the root layout in the browser. The
// server sends type="text/javascript", the client renders "text/plain", and
// suppressHydrationWarning covers the difference. From Next's "Preventing
// flash before hydration" guide.
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
