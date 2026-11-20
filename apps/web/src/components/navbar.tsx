"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clapperboard, LogOut, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CapabilitiesDto, UserDto } from "@/components/types";

export function Navbar({
  user,
  capabilities,
}: {
  user: UserDto | null;
  capabilities: CapabilitiesDto | null;
}) {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 border-b border-border/80 bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="flex h-7 w-7 items-center justify-center rounded-md border border-border/80 bg-secondary/80 text-foreground transition-colors group-hover:border-border">
            <Clapperboard className="h-4 w-4" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-tight text-foreground">ClipForge</span>
            <span className="rounded border border-border/60 bg-secondary/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Studio
            </span>
          </div>
        </Link>

        <div className="flex items-center gap-2.5">
          {capabilities && (
            <div className="hidden items-center gap-2 md:flex">
              <span className="inline-flex items-center gap-1.5 rounded border border-border/60 bg-secondary/30 px-2 py-0.5 text-xs text-muted-foreground">
                <span className={cn("h-1.5 w-1.5 rounded-full", capabilities.youtubeApiConfigured ? "bg-emerald-400" : "bg-amber-400")} />
                YT: {capabilities.youtubeApiConfigured ? "Data API" : "oEmbed"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded border border-border/60 bg-secondary/30 px-2 py-0.5 text-xs text-muted-foreground">
                <span className={cn("h-1.5 w-1.5 rounded-full", capabilities.whisperConfigured ? "bg-emerald-400" : "bg-amber-400")} />
                ASR: {capabilities.sttProviderLabel}
              </span>
            </div>
          )}

          {user && (
            <div className="flex items-center gap-2">
              <div className="hidden items-center gap-1.5 rounded border border-border/60 bg-secondary/30 px-2 py-1 text-xs text-muted-foreground sm:flex">
                <ShieldCheck className="h-3 w-3 text-emerald-400/90" />
                <span className="max-w-[140px] truncate text-foreground">{user.name}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={handleLogout} className="text-muted-foreground hover:text-foreground">
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
