import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except Next internals, static image assets and the queue
    // worker's route, whose requests come from pg_net with a bearer and no
    // session cookie, so there is no session to refresh.
    "/((?!_next/static|_next/image|favicon.ico|api/extraction-worker|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
