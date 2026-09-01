// The daily operations mail. Everything it reports is computed by
// public.ops_report() in one call — this function formats, it does not
// calculate. Two modes, both driven by pg_cron:
//
//   (no body / {"mode":"daily"})  once a morning, the full report
//   {"mode":"alert"}              every 15 minutes, and only when a NEW kind
//                                 of error has appeared since the last check
//
// The alert mode is what makes a quiet daily report safe to skim: anything
// genuinely new interrupts you the same hour, so the morning mail never has to
// be read as an emergency.

import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const MAIL_FROM = Deno.env.get("REPORT_FROM") ?? "MacroTrack <onboarding@resend.dev>";

/** Escapes every value interpolated into the HTML.
 *
 *  Nothing reaching this file is attacker-controlled — ops_events stores no
 *  free text and `code` is a closed allowlist — but email addresses come from
 *  open signup (anyone may register), and a name is one refactor away from
 *  being rendered. Escaping unconditionally means a future change that starts
 *  carrying user text cannot turn this mail into a phishing surface aimed at
 *  the person who owns the deployment. */
const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Strips anything that could forge a line in the plain-text part. */
const txt = (v: unknown) => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim();

interface Report {
  day: string;
  people: {
    signups: { email: string; at: string; logged: number }[];
    stalled: { email: string; days: number }[];
    trials: { email: string; daysLeft: number; used: number; limit: number }[];
    total: number;
    logged: number;
  };
  usage: {
    analyses: number; images: number; active: number; entries: number;
    images7d: number; imagesMtd: number;
    sources: Record<string, number>;
    roster: { email: string; entries: number; byHand: number; analyses: number }[];
  };
  errors: {
    total: number;
    events: { source: string; code: string; severity: string; count: number; users: number; last: string }[];
  };
}

/** Rough Anthropic spend. One analysis is a ~1k-token system prompt plus up to
 *  40 saved-food rows, ~2.5k tokens per 1600px image, and ~1.3k output tokens
 *  at effort=medium — about 4.5c fixed plus 1.3c an image against claude-opus-5.
 *  Deliberately labelled an estimate wherever it is shown: MACROTRACK_MODEL and
 *  MACROTRACK_EFFORT are both env-overridable, so this is an indication of the
 *  shape of the bill, not the bill. */
const spend = (images: number, calls: number) => 0.045 * calls + 0.013 * images;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** Human names for the codes. The allowlist lives in the migration; this is
 *  only presentation, and an unknown code falls back to the raw string rather
 *  than being dropped. */
const CODE_LABEL: Record<string, string> = {
  credit_rpc_failed: "Quota check failed",
  photo_upload_failed: "Photo upload failed — the image was lost",
  evidence_insert_failed: "Evidence not saved — capture cannot be retried",
  evidence_link_failed: "Evidence left orphaned — retention deletes it in 2 days",
  model_failed: "Analysis failed",
  no_entries_returned: "Model found no food in the photo",
  entry_insert_failed: "Could not save the food entry",
  nothing_to_analyze: "Empty capture (no photo, note, or voice)",
  retry_evidence_missing: "Try again found nothing to retry",
  push_subscribe_failed: "Push subscription failed",
  job_failed: "Scheduled job failed",
};

function render(r: Report) {
  const e = r.errors;
  const red = e.total > 0;
  const day = new Date(r.day + "T12:00:00Z").toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });

  // The subject carries the whole state, so a normal day never needs opening.
  const subject = red
    ? `🔴 MacroTrack · ${day} · ${e.total} error${e.total === 1 ? "" : "s"}`
    : `MacroTrack · ${day} · ${r.usage.analyses} analyses · ${r.usage.active} active` +
      (r.people.signups.length ? ` · ${r.people.signups.length} new` : "");

  const card = (title: string, body: string) => `
    <tr><td style="padding:0 0 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="border:1px solid #e6e0d8;border-radius:14px;background:#fffdfa;">
        <tr><td style="padding:16px 18px;">
          <div style="font:600 11px/1 -apple-system,Segoe UI,Roboto,sans-serif;
                      letter-spacing:.10em;text-transform:uppercase;color:#9a8f82;padding-bottom:12px;">
            ${esc(title)}
          </div>
          ${body}
        </td></tr>
      </table>
    </td></tr>`;

  const stat = (label: string, value: string) => `
    <td style="padding:0 14px 0 0;">
      <div style="font:700 22px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#2b2521;">${esc(value)}</div>
      <div style="font:400 11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#9a8f82;padding-top:3px;">${esc(label)}</div>
    </td>`;

  const row = (l: string, v: string) => `
    <div style="font:400 13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#4a4038;">
      <span style="color:#2b2521;">${esc(l)}</span>
      <span style="color:#9a8f82;"> — ${esc(v)}</span>
    </div>`;

  /* --- errors first: Gmail clips long mail from the bottom, and this is the
         half the red subject line just promised. ------------------------- */
  const errorsCard = card(
    e.total ? `${e.total} error${e.total === 1 ? "" : "s"}` : "Errors",
    e.events.length
      ? e.events.map((v) => `
          <div style="padding:8px 0;border-top:1px solid #f0ebe4;">
            <div style="font:600 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;
                        color:${v.severity === "error" ? "#b4462a" : "#8a7a5e"};">
              ${esc(CODE_LABEL[v.code] ?? v.code)}
            </div>
            <div style="font:400 12px/1.5 ui-monospace,Menlo,monospace;color:#9a8f82;padding-top:2px;">
              ${esc(v.count)}× · ${esc(v.users)} user${v.users === 1 ? "" : "s"} · last ${esc(v.last)} · ${esc(v.source)}
            </div>
          </div>`).join("")
      : `<div style="font:400 13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#5d8a4a;">
           Nothing failed.
         </div>`,
  );

  const usageCard = card("Usage", `
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      ${stat("analyses", String(r.usage.analyses))}
      ${stat("active", String(r.usage.active))}
      ${stat("entries", String(r.usage.entries))}
      ${stat("est. spend", usd(spend(r.usage.images, r.usage.analyses)))}
    </tr></table>
    <div style="font:400 12px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#9a8f82;padding-top:12px;">
      7-day avg ${esc(usd(spend(r.usage.images7d, r.usage.images7d) / 7))}/day ·
      month to date ${esc(usd(spend(r.usage.imagesMtd, r.usage.imagesMtd)))} (estimated)
    </div>
    ${r.usage.roster.length ? `<div style="padding-top:12px;">` +
      r.usage.roster.map((u) =>
        row(u.email, `${u.entries} entries${u.byHand ? ` (${u.byHand} by hand)` : ""} · ${u.analyses} analyses`),
      ).join("") + `</div>` : ""}
    ${Object.keys(r.usage.sources).length
      ? `<div style="font:400 12px/1.6 ui-monospace,Menlo,monospace;color:#9a8f82;padding-top:10px;">` +
        Object.entries(r.usage.sources).map(([k, n]) => `${esc(k)} ${esc(n)}`).join(" · ") + `</div>`
      : ""}
  `);

  const p = r.people;
  const peopleCard = card("People", `
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      ${stat("registered", String(p.total))}
      ${stat("ever logged", String(p.logged))}
    </tr></table>
    ${p.signups.length ? `<div style="padding-top:12px;">
      <div style="font:600 12px/1.6 -apple-system,sans-serif;color:#2b2521;">New today</div>
      ${p.signups.map((s) => row(s.email, `${s.at} · ${s.logged} entries so far`)).join("")}
    </div>` : ""}
    ${p.trials.length ? `<div style="padding-top:12px;">
      <div style="font:600 12px/1.6 -apple-system,sans-serif;color:#b4462a;">Trials ending</div>
      ${p.trials.map((t) => row(t.email,
        t.daysLeft === 0 ? `expired · ${t.used}/${t.limit} used`
                         : `${t.daysLeft}d left · ${t.used}/${t.limit} used`)).join("")}
    </div>` : ""}
    ${p.stalled.length ? `<div style="padding-top:12px;">
      <div style="font:600 12px/1.6 -apple-system,sans-serif;color:#2b2521;">Signed up, never logged</div>
      ${p.stalled.map((s) => row(s.email, `${s.days}d ago`)).join("")}
    </div>` : ""}
  `);

  const html = `
<div style="margin:0;padding:20px 12px;background:#f6f2ec;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">
    <tr><td style="padding:0 0 16px;">
      <div style="font:700 17px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;color:#2b2521;">
        MacroTrack · ${esc(day)}
      </div>
    </td></tr>
    ${errorsCard}
    ${usageCard}
    ${peopleCard}
    <tr><td style="font:400 11px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#a89c8e;padding-top:4px;">
      Window: ${esc(r.day)} 00:00–24:00 America/Chicago. Spend is an estimate from image
      counts, not billed usage.
    </td></tr>
  </table>
</div>`;

  const text = [
    `MacroTrack — ${txt(day)}`,
    ``,
    `ERRORS: ${e.total}`,
    ...e.events.map((v) => `  ${txt(CODE_LABEL[v.code] ?? v.code)} — ${v.count}x, ${v.users} user(s), last ${txt(v.last)}`),
    ``,
    `USAGE: ${r.usage.analyses} analyses, ${r.usage.active} active, ${r.usage.entries} entries`,
    `  est. spend ${usd(spend(r.usage.images, r.usage.analyses))} · MTD ${usd(spend(r.usage.imagesMtd, r.usage.callsMtd))}`,
    ...r.usage.roster.map((u) => `  ${txt(u.email)} — ${u.entries} entries, ${u.analyses} analyses`),
    ``,
    `PEOPLE: ${p.total} registered, ${p.logged} have ever logged`,
    ...p.signups.map((s) => `  new: ${txt(s.email)} at ${txt(s.at)}`),
    ...p.trials.map((t) => `  trial: ${txt(t.email)} — ${t.daysLeft}d left, ${t.used}/${t.limit}`),
    ...p.stalled.map((s) => `  never logged: ${txt(s.email)} (${s.days}d)`),
  ].join("\n");

  return { subject, html, text };
}

async function send(to: string, subject: string, html: string, text: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("Forbidden", { status: 403 });
  }

  // The recipient is configuration, never source: this repo is public. It
  // lives in the same app_settings row the trial wall already reads.
  const { data: settings } = await supabase
    .from("app_settings")
    .select("contact_email")
    .limit(1)
    .maybeSingle();
  const to = (settings?.contact_email ?? "").trim();
  if (!to) return Response.json({ ok: false, reason: "no contact_email set" });

  let mode = "daily";
  try {
    mode = (await req.json())?.mode ?? "daily";
  } catch {
    // pg_cron posts '{}'; a missing or unparseable body means the daily run.
  }

  /* ---------------------------------------------------------- alert mode */
  if (mode === "alert") {
    // Only error-severity buckets that have never been alerted on. Warnings —
    // an empty capture, say — are ordinary user behaviour and must never
    // interrupt anyone.
    const { data: fresh } = await supabase
      .from("ops_events")
      .select("source, code, occurrences, last_seen_at")
      .is("alerted_at", null)
      .eq("severity", "error")
      .order("last_seen_at", { ascending: false })
      .limit(10);

    if (!fresh?.length) return Response.json({ ok: true, sent: 0 });

    const lines = fresh.map((f) =>
      `${CODE_LABEL[f.code as string] ?? f.code} — ${f.occurrences}× (${f.source})`);

    await send(
      to,
      `🔴 MacroTrack — new error: ${CODE_LABEL[fresh[0].code as string] ?? fresh[0].code}`,
      `<div style="font:400 14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#2b2521;padding:16px;">
         <p style="margin:0 0 10px;font-weight:600;">Something started failing.</p>
         ${lines.map((l) => `<div style="color:#b4462a;">${esc(l)}</div>`).join("")}
         <p style="margin:12px 0 0;color:#9a8f82;font-size:12px;">
           Full detail in tomorrow&rsquo;s report. You will not be told about these again.
         </p>
       </div>`,
      ["Something started failing.", "", ...lines.map(txt)].join("\n"),
    );

    // Marked only after the mail is away, so a Resend outage retries next
    // quarter-hour rather than losing the alert entirely.
    await supabase
      .from("ops_events")
      .update({ alerted_at: new Date().toISOString() })
      .is("alerted_at", null)
      .eq("severity", "error");

    return Response.json({ ok: true, sent: 1, alerts: fresh.length });
  }

  /* ---------------------------------------------------------- daily mode */
  const { data, error } = await supabase.rpc("ops_report");

  if (error || !data) {
    // A silent daily report is worse than none: absence reads as "all is
    // well". If the report cannot be built, say so in the same channel.
    await send(
      to,
      "🔴 MacroTrack — daily report failed to build",
      `<div style="font:400 14px/1.6 -apple-system,sans-serif;padding:16px;">
         <p>ops_report() did not return.</p>
         <pre style="white-space:pre-wrap;color:#b4462a;">${esc(error?.message ?? "no data")}</pre>
       </div>`,
      `ops_report() did not return.\n${txt(error?.message ?? "no data")}`,
    );
    return Response.json({ ok: false, sent: 1, degraded: true });
  }

  const { subject, html, text } = render(data as Report);
  await send(to, subject, html, text);

  // Counters only. verify_jwt is false on this function, so the URL is
  // reachable by anyone who guesses it and only x-cron-secret stands in
  // front — returning the body would turn a secret leak into a dump of every
  // registered user's email address.
  return Response.json({ ok: true, sent: 1 });
});
