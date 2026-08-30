import { redirect } from "next/navigation";
import App from "@/components/App";
import { loadBootstrap } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function Page() {
  const initial = await loadBootstrap();
  if (!initial) redirect("/signin");
  return <App initial={initial} />;
}
