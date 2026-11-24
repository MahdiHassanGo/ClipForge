"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Clapperboard, KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { AI_PROVIDER_CATALOG } from "@clipforge/core/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiProviderDto, CapabilitiesDto, UserDto } from "@/components/types";

export function Navbar({
  user,
  capabilities,
  aiProviders = [],
}: {
  user: UserDto | null;
  capabilities: CapabilitiesDto | null;
  aiProviders?: AiProviderDto[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const activeAi =
    aiProviders.find((p) => p.isEnabled && p.isDefault) ??
    aiProviders.find((p) => p.isEnabled) ??
    null;

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="group flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/30 bg-primary/15 text-primary transition-colors group-hover:bg-primary/20">
              <Clapperboard className="h-4 w-4" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold tracking-tight text-foreground">
                ClipForge
              </span>
              <span className="text-xs text-muted-foreground">Studio</span>
            </div>
          </Link>

          {user && (
            <nav className="hidden items-center gap-1 sm:flex">
              <Link
                href="/"
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                  pathname === "/" || pathname.startsWith("/jobs")
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Projects
              </Link>
              <Link
                href="/settings/ai"
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                  pathname.startsWith("/settings/ai")
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <KeyRound className="h-3.5 w-3.5 text-primary" />
                AI Keys
                {activeAi && (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {AI_PROVIDER_CATALOG[activeAi.provider].shortName}
                  </span>
                )}
              </Link>
            </nav>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          {capabilities && (
            <div className="hidden items-center gap-2 md:flex">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2 py-1 text-xs text-muted-foreground">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    capabilities.youtubeApiConfigured ? "bg-emerald-400" : "bg-primary",
                  )}
                />
                YT: {capabilities.youtubeApiConfigured ? "Data API" : "oEmbed"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2 py-1 text-xs text-muted-foreground">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    capabilities.whisperConfigured ? "bg-emerald-400" : "bg-primary",
                  )}
                />
                ASR: {capabilities.sttProviderLabel}
              </span>
            </div>
          )}

          {user && (
            <div className="flex items-center gap-2">
              <Link href="/settings/ai" className="sm:hidden">
                <Button variant="outline" size="sm">
                  <KeyRound className="h-3.5 w-3.5 text-primary" />
                  AI Keys
                </Button>
              </Link>
              <div className="hidden items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-muted-foreground sm:flex">
                <ShieldCheck className="h-3.5 w-3.5 text-accent" />
                <span className="max-w-[140px] truncate text-foreground">{user.name}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                className="text-muted-foreground hover:text-foreground"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
