"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/** Email + one-time code. A code beats a magic link here: tapping a link from
 *  Mail can't hand the session back to an installed PWA reliably, but typing a
 *  code works in every context the app runs in. */
/** The signup allowlist lives in a database trigger, so Supabase reports a
 *  rejection as a generic database error. Say what actually happened. */
function friendly(message: string): string {
  if (/database error (creating|saving) new user/i.test(message)) {
    return "That address isn't set up for this tracker.";
  }
  return message;
}

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    });
    setBusy(false);
    if (error) setError(friendly(error.message));
    else setSent(true);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    setBusy(false);
    if (error) {
      setError(friendly(error.message));
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col justify-center px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(24px,env(safe-area-inset-top))]">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
        MacroTrack AI
      </p>
      <h1 className="mt-2.5 text-[27px] font-extrabold leading-[1.15] tracking-[-0.025em] text-balance">
        {sent ? "Check your email for a code." : "Let's get you signed in."}
      </h1>
      <p className="mt-2.5 text-[14px] leading-[1.5] text-muted-alt">
        {sent
          ? `We sent a sign-in code to ${email}. It's good for an hour.`
          : "One account, one tracker. You'll stay signed in on this device."}
      </p>

      <form
        onSubmit={sent ? verify : sendCode}
        className="mt-6 flex flex-col gap-2.5"
      >
        {!sent ? (
          <input
            type="email"
            required
            autoFocus
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="rounded-[18px] border border-line bg-raised px-4 py-4 text-[15px] outline-none placeholder:text-faint focus:border-accent"
          />
        ) : (
          <input
            required
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={10}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="Enter your code"
            className="tnum rounded-[18px] border border-line bg-raised px-4 py-4 text-center font-mono text-[22px] font-bold tracking-[0.28em] outline-none placeholder:text-[13px] placeholder:font-sans placeholder:font-normal placeholder:tracking-normal placeholder:text-faint focus:border-accent"
          />
        )}

        <button
          type="submit"
          disabled={busy}
          className="rounded-[18px] bg-accent px-4 py-[15px] text-[15px] font-bold text-surface transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? "Working…" : sent ? "Sign in" : "Send code"}
        </button>

        {sent && (
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setCode("");
              setError(null);
            }}
            className="py-3 text-[13px] font-semibold text-faint"
          >
            Use a different email
          </button>
        )}
      </form>

      {error && (
        <p className="mt-3 rounded-[16px] border border-danger-line px-4 py-3 text-[13px] leading-[1.45] text-danger">
          {error}
        </p>
      )}
    </main>
  );
}
