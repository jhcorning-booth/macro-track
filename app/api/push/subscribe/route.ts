import { NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Stores (or refreshes) this device's push endpoint. Endpoints rotate, so the
 *  client calls this on every permission grant and the row upserts. */
export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const body = (await req.json()) as {
    endpoint?: string;
    p256dh?: string;
    auth?: string;
  };

  if (!body.endpoint || !body.p256dh || !body.auth) {
    return new Response("Incomplete subscription", { status: 400 });
  }

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint: body.endpoint,
      p256dh: body.p256dh,
      auth: body.auth,
      last_seen: new Date().toISOString(),
    },
    { onConflict: "endpoint" },
  );

  if (error) return new Response(error.message, { status: 500 });
  return Response.json({ ok: true });
}

/** Detaches this device on sign-out, so the next person to use the browser
 *  doesn't inherit the previous account's nudges. */
export async function DELETE(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { endpoint } = (await req.json()) as { endpoint?: string };
  if (!endpoint) return new Response("Missing endpoint", { status: 400 });

  // Scoped by user_id as well as endpoint: RLS already enforces this, but the
  // explicit filter keeps the intent obvious.
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("user_id", user.id)
    .eq("endpoint", endpoint);

  if (error) return new Response(error.message, { status: 500 });
  return Response.json({ ok: true });
}
