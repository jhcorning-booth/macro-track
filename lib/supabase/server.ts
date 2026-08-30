import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/** Request-scoped client that carries the signed-in user's session, so every
 *  query runs under RLS as that user. */
export async function createSupabaseServerClient() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) =>
              store.set(name, value, options),
            );
          } catch {
            // Called from a Server Component render — the middleware refreshes
            // the session cookie instead, so this is safe to swallow.
          }
        },
      },
    },
  );
}

/** Throws if there is no session. Route handlers rely on this. */
export async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Response("Unauthorized", { status: 401 });
  return { supabase, user };
}
