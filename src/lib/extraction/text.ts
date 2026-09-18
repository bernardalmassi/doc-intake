// Text hygiene for strings that come from a model and go to Postgres or to
// a pattern check. A document controls what the model writes, so these
// strings can hold anything a document can: a U+0000 (a PDF that literally
// contains the six characters of its JSON escape is enough, the model
// copies the escape), an unpaired surrogate (a cut through an emoji), bidi
// overrides that make a reviewer read text in a different order, or
// zero-width characters and full-width letters that hide a word from a
// regex. Postgres refuses a U+0000 and an unpaired surrogate in text or
// jsonb, and a refused close_extraction_run leaves the run running and
// unmetered.
//
// No imports, so every module in the extraction path can use it. Written
// with escapes only, so no invisible character sits in the source.

// C0 controls except tab, newline and carriage return; DEL; C1 controls;
// the bidi embedding, override and isolate controls.
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

// What validateExtraction does to every string the model returns: drop the
// characters above, then replace any unpaired surrogate with U+FFFD.
export function cleanModelText(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, "").toWellFormed();
}

// The first max UTF-16 units of a well-formed string, one fewer if the cut
// would leave half of a surrogate pair. The result has at most max
// characters by Postgres's count too, which counts code points.
export function sliceWellFormed(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// The last line of defence before a string goes into the close RPC: no
// U+0000, well formed, and within the column's check.
export function databaseText(text: string, max?: number): string {
  const clean = text.replace(/\u0000/g, "").toWellFormed();
  return max === undefined ? clean : sliceWellFormed(clean, max);
}

// One form for pattern checks: compatibility-normalized (full-width
// letters and digits, ligatures and non-breaking spaces become their plain
// forms) with every default-ignorable code point removed (zero-width
// spaces and joiners, soft hyphens, variation selectors). A check run on
// this can't be dodged by a full-width "ignore", a soft hyphen inside a
// word or a zero-width space inside "total_amount". Letters that only look
// alike across scripts (a Cyrillic letter for a Latin one) are not folded.
export function canonicalize(text: string): string {
  return text.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "");
}
