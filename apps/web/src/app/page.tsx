import { getCurrentUser } from "@/lib/session";
import { getAppCapabilities } from "@/lib/env";
import { DashboardClient } from "@/components/dashboard-client";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [user, capabilities] = await Promise.all([
    getCurrentUser(),
    Promise.resolve(getAppCapabilities()),
  ]);

  return (
    <DashboardClient
      initialUser={user}
      initialCapabilities={capabilities}
    />
  );
}
