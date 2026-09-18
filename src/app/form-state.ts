import type { ErrorCode } from "@/lib/errors";

// What a Server Action behind a form returns. `error` is a code from
// src/lib/errors.ts, never text: the page shows userFacingError(error)
// .message, so nothing Postgres, Supabase Auth, Storage or a model provider
// wrote can reach the screen. `message` is a sentence this app wrote, for a
// success worth saying something about.
export type FormState = { error?: ErrorCode; message?: string };
