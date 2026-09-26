// Hand-drawn 16px icons in currentColor. Decorative: every one sits next to
// text that says the same thing, so they are aria-hidden. One is left: the
// chevron of a fold or a line that opens. A state has its glyph
// (state-glyph.tsx), and an error or a step is said in words.

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
