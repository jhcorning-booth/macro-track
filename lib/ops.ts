import "server-only";

import type { createSupabaseServerClient } from "@/lib/supabase/server";

/** Where a failure happened. Must match the CHECK on public.ops_events.source. */
export type OpsSource = "api_analyze" | "api_push" | "edge_nudges" | "edge_retention";

/** What went wrong. A closed set, mirroring the CHECK on public.ops_events.code
 *  — the database rejects anything else, and the daily report can therefore
 *  only ever render a string chosen here rather than one a caller supplied.
 *
 *  There is deliberately no message parameter anywhere in this module. The
 *  things that fail in this app fail while holding a user's note or transcript
 *  ("two scoops at my mother's"), and that text would end up in an operations
 *  table and then in an email to a third-party mail API every morning. The code
 *  says what broke; Vercel's own logs say the rest, for whoever is entitled to
 *  read them. */
export type OpsCode =
  | "credit_rpc_failed"
  | "photo_upload_failed"
  | "evidence_insert_failed"
  | "evidence_link_failed"
  | "model_failed"
  | "no_entries_returned"
  | "entry_insert_failed"
  | "nothing_to_analyze"
  | "retry_evidence_missing"
  | "push_subscribe_failed"
  | "job_failed";

type Supa = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export interface OpsRecorder {
  /** Note a failure. Never throws and never rejects. */
  record(code: OpsCode, severity?: "error" | "warn"): void;
  /** Whether any specific cause has already been named for this request. Lets
   *  a catch-all handler avoid double-counting a failure that a more precise
   *  site upstream already recorded. */
  named(): boolean;
  /** Wait for the notes to land. Never throws. */
  flush(): Promise<void>;
}

/** Collects failures for one request and writes them through
 *  `record_ops_event`, which is SECURITY DEFINER because the API routes run as
 *  the signed-in user and the service-role key is deliberately not on the web
 *  host.
 *
 *  Two rules govern everything here:
 *
 *  1. **It cannot break its caller.** Every write is wrapped so a rejection is
 *     swallowed, on top of the exception handler inside the SQL function
 *     itself. This is called from catch blocks; telemetry that turns a handled
 *     error into an unhandled one is worse than no telemetry.
 *
 *  2. **It is flushed, not fired and forgotten.** A floating promise started
 *     just before `controller.close()` is not guaranteed to run to completion
 *     on a serverless host — and the failures recorded latest are the ones
 *     recorded after the entry is persisted, including `evidence_link_failed`,
 *     which is exactly the fault that makes retention delete the user's photo
 *     two days later. Those are the ones you least want dropped. */
export function opsRecorder(supabase: Supa, source: OpsSource): OpsRecorder {
  const pending: Promise<unknown>[] = [];
  let namedCause = false;

  return {
    named: () => namedCause,

    record(code, severity = "error") {
      namedCause = true;
      try {
        pending.push(
          Promise.resolve(
            supabase.rpc("record_ops_event", {
              p_source: source,
              p_code: code,
              p_severity: severity,
            }),
          ).then(
            () => undefined,
            () => undefined,
          ),
        );
      } catch {
        // rpc() threw synchronously — nothing to record, nothing to do.
      }
    },

    async flush() {
      if (!pending.length) return;
      try {
        await Promise.allSettled(pending);
      } catch {
        // allSettled does not reject; this is belt and braces.
      } finally {
        pending.length = 0;
      }
    },
  };
}
