// The queue worker's endpoint (docs/worker-design.md, section 4). pg_net
// POSTs {} here once an enqueue commits, and the queue's sweep again for a
// wake that never arrived, with "Authorization: Bearer <secret>" from the
// app project's Vault. A wrong or missing bearer gets 401 and nothing is
// read. Otherwise the delivery is scheduled in after() and the 202 goes out
// at once: pg_net waits 5 s at most, and nothing touches the queue before
// the response, so a request cut off early leaves the message unread for
// the sweep to wake again. The proxy doesn't run here (src/proxy.ts): the
// request has no session to refresh.

import { after } from "next/server";
import { selectProviders } from "@/lib/extraction/providers/select";
import { isAuthorizedWorkerRequest, processOneDelivery } from "@/lib/extraction/worker";
import { log } from "@/lib/log";

// Seconds this function, after() included, may run. A delivery's model calls
// and the token counts before them are bounded at 225 s (three calls of 60 s,
// each counted first in at most 15 s, config.ts); this leaves 55 s for the
// download and the claim and finish RPCs, stays under the host's 300 s, and
// ends before the claimed message's visibility timeout
// (workerVisibilitySeconds, 300 s), so no second delivery of it can start
// while this one may still run. A literal, because Next.js reads it
// statically; tests/unit/max-duration.test.ts checks the bounds.
export const maxDuration = 280;

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorizedWorkerRequest(request.headers.get("authorization"))) {
    log.warn("worker.unauthorized");
    return new Response(null, { status: 401 });
  }
  after(() => processOneDelivery({ providers: selectProviders }));
  return new Response(null, { status: 202 });
}
