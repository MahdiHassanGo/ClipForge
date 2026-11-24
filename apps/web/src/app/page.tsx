import { getCurrentUser } from "@/lib/session";
import { getAppCapabilities } from "@/lib/env";
import { listUserAiProviders } from "@/lib/ai-provider-store";
import { DashboardClient } from "@/components/dashboard-client";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [user, capabilities] = await Promise.all([
    getCurrentUser(),
    Promise.resolve(getAppCapabilities()),
  ]);

  const aiProviders = user ? await listUserAiProviders(user.id) : [];

  return (
    <DashboardClient
      initialUser={user}
      initialCapabilities={capabilities}
      initialAiProviders={aiProviders}
    />
  );
}
