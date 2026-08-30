/**
 * Puts CRON_SECRET into Supabase Vault so the pg_cron jobs can authenticate to
 * the Edge Functions. Run once after `supabase db push`, and again whenever you
 * rotate the secret.
 *
 *   npm run setup:cron
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const secret = env.CRON_SECRET;
if (!secret) throw new Error("CRON_SECRET is missing from .env.local");
if (!/^[A-Za-z0-9_-]+$/.test(secret)) {
  throw new Error("CRON_SECRET must be url-safe base64 (A-Z a-z 0-9 _ -)");
}

const sql = `
do $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'macrotrack_cron_secret';
  if v_id is null then
    perform vault.create_secret('${secret}', 'macrotrack_cron_secret',
      'Shared secret pg_cron sends to the MacroTrack Edge Functions');
  else
    perform vault.update_secret(v_id, '${secret}');
  end if;
end $$;
select name, created_at from vault.secrets where name = 'macrotrack_cron_secret';
`;

// Written to a file rather than passed as an argv string, so the secret never
// shows up in the process list.
const dir = mkdtempSync(join(tmpdir(), "macrotrack-"));
const file = join(dir, "vault.sql");
try {
  writeFileSync(file, sql, { mode: 0o600 });
  execFileSync("supabase", ["db", "query", "--linked", "-f", file], { stdio: "inherit" });
  console.log("\ncron secret stored in Vault.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
