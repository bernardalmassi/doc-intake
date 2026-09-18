// Hand-drawn 16px icons in currentColor. Decorative: every one sits next to
// text that says the same thing, so they are aria-hidden.

type IconProps = { className?: string };

function Icon({ className, children, size = 16 }: IconProps & { children: React.ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className ?? ""}`}
    >
      {children}
    </svg>
  );
}

export function ChevronRightIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Icon>
  );
}

// Two stacked pages, for the empty document list.
export function DocumentsIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 40 40"
      width="40"
      height="40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className ?? ""}`}
    >
      <path d="M13 8.5V6.75C13 6.06 13.56 5.5 14.25 5.5H26l7 7v19.75c0 .69-.56 1.25-1.25 1.25H28.5" />
      <path d="M26 5.5v7h7" />
      <path d="M8.25 9.5H20l7 7v17.75c0 .69-.56 1.25-1.25 1.25H8.25C7.56 35.5 7 34.94 7 34.25V10.75c0-.69.56-1.25 1.25-1.25Z" />
      <path d="M20 9.5v7h7" />
      <path d="M11.5 21.5h11M11.5 25.5h11M11.5 29.5h7" strokeLinecap="round" />
    </svg>
  );
}

// An arrow rising out of a tray: the upload area.
export function UploadIcon({ className }: IconProps) {
  return (
    <Icon className={className} size={20}>
      <path d="M8 10.5V2.5M5 5.5l3-3 3 3" />
      <path d="M2.5 10v2.25c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25V10" />
    </Icon>
  );
}

// A page with a folded corner: a chosen file.
export function FileIcon({ className }: IconProps) {
  return (
    <Icon className={className} size={20}>
      <path d="M9.5 1.75H4.25c-.69 0-1.25.56-1.25 1.25v10c0 .69.56 1.25 1.25 1.25h7.5c.69 0 1.25-.56 1.25-1.25V5.25L9.5 1.75Z" />
      <path d="M9.5 1.75v3.5H13" />
    </Icon>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </Icon>
  );
}

// A step not reached yet.
export function DotIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="2.5" />
    </Icon>
  );
}

// Work in progress. Spins only when the visitor hasn't asked for reduced
// motion; the text next to it says the same thing either way.
export function SpinnerIcon({ className }: IconProps) {
  return (
    <Icon className={`motion-safe:animate-spin ${className ?? ""}`}>
      <circle cx="8" cy="8" r="5.5" className="stroke-line-strong" />
      <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" />
    </Icon>
  );
}

// An exclamation mark in a circle: something to look at.
export function AlertIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75v3.75" />
      <path d="M8 11.1v.15" strokeWidth="2" />
    </Icon>
  );
}
