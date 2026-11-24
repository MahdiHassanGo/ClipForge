import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/session";
import { getAppCapabilities } from "@/lib/env";
import { listUserAiProviders } from "@/lib/ai-provider-store";
import { Navbar } from "@/components/navbar";
import { AiProvidersPanel } from "@/components/ai-providers-panel";

export const dynamic = "force-dynamic";

export default async function AiSettingsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/");
  }

  const [capabilities, providers] = await Promise.all([
    Promise.resolve(getAppCapabilities()),
    listUserAiProviders(user.id),
  ]);

  return (
    <div className="min-h-screen pb-16">
      <Navbar user={user} capabilities={capabilities} aiProviders={providers} />

      <main className="mx-auto max-w-6xl space-y-6 px-4 pt-8 sm:px-6">
        <div className="space-y-2">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to projects
          </Link>
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            AI provider keys
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Bring your own Claude, ChatGPT, OpenRouter, Gemini, Groq, or local Ollama endpoint so ClipForge&apos;s Video Director can search your videos, find exact moments, and apply edits for you.
          </p>
        </div>

        <AiProvidersPanel initialProviders={providers} />
      </main>
    </div>
  );
}
