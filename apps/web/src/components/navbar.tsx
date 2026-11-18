"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clapperboard, LogOut, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
    <header className="sticky top-0 z-30 border-b border-border/80 bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
            <Clapperboard className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight">ClipForge</span>
              <Badge variant="secondary" className="hidden sm:inline-flex">
                9:16 Studio
              </Badge>
            </div>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              Authorized gaming highlights · Shorts · TikTok · Reels
            </p>
          </div>
        </Link>

        <div className="flex items-center gap-3">
          {capabilities && (
            <div className="hidden items-center gap-2 md:flex">
              <Badge variant={capabilities.youtubeApiConfigured ? "success" : "warning"}>
                YT Metadata: {capabilities.youtubeApiConfigured ? "Data API" : "oEmbed"}
              </Badge>
              <Badge variant={capabilities.whisperConfigured ? "success" : "warning"}>
                ASR: {capabilities.sttProviderLabel}
              </Badge>
            </div>
          )}

          {user && (
            <div className="flex items-center gap-2.5">
              <div className="hidden items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2.5 py-1 text-xs text-muted-foreground sm:flex">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                <span className="max-w-[140px] truncate text-foreground">{user.name}</span>
              </div>
              <Button variant="outline" size="sm" onClick={handleLogout}>
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
