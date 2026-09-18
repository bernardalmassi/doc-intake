// Shared by the root layout (server) and the theme toggle (client), so the
// script that runs before first paint and the toggle can't disagree about
// the storage key or the accepted values. Not a "use client" module: the
// layout needs the real string, not a client reference.

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "theme";

// Dark is the default whatever the OS says, so only an explicit stored
// "light" or "dark" counts. localStorage throws when storage is blocked.
export function readStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

// Inlined into <head> and run while the HTML is parsed, before first paint,
// so a visitor who chose light never sees the dark default. Same rules as
// readStoredTheme; it can't import it because it runs before any bundle.
export const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;
