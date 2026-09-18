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
