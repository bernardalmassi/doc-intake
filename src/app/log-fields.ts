import type { LogFields } from "@/lib/log";

// What a log line may say about a failed Supabase call: the SQLSTATE, the
// HTTP status and the error's class name, never its message. PostgREST's
// own codes (PGRST116) aren't SQLSTATEs and are left out rather than
// counted as dropped fields.
export function failureFields(
  error: { code?: string | null; name?: string | null } | null | undefined,
  status?: number | null,
): Pick<LogFields, "db_code" | "http_status" | "error_name"> {
  const code = error?.code ?? "";
  const name = error?.name ?? "";
  return {
    db_code: /^[0-9A-Z]{5}$/.test(code) ? code : undefined,
    http_status: typeof status === "number" && status >= 100 && status <= 599 ? status : undefined,
    error_name: /^[A-Z][A-Za-z]{0,39}$/.test(name) ? name : undefined,
  };
}
