// The orchestrator writes a log line per call and the unit tests run
// thousands of calls, so in tests the logger writes nowhere unless a test
// captures its lines with setLogSink (tests/unit/log.test.ts does).

import { setLogSink } from "@/lib/log";

setLogSink(() => {});
