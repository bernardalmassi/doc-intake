// Shared Tailwind class strings. Inputs and buttons need explicit colors:
// on a dark background the browser defaults are nearly invisible.
export const inputClass =
  "mt-1 block w-full max-w-sm rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-300 focus:outline-none";

export const buttonClass =
  "rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonClass =
  "rounded border border-neutral-600 px-3 py-1.5 text-sm text-neutral-100 hover:border-neutral-300 disabled:cursor-not-allowed disabled:opacity-50";

export const dangerButtonClass =
  "rounded border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:border-red-500 disabled:cursor-not-allowed disabled:opacity-50";

export const linkClass = "underline underline-offset-4 hover:text-white";

export const labelClass = "block text-sm text-neutral-300";

export const errorClass = "text-sm text-red-400";
