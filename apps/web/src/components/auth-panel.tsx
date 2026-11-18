"use client";

import { useState } from "react";
import { Clapperboard, Lock, Sparkles, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { UserDto } from "@/components/types";

export function AuthPanel({ onSuccess }: { onSuccess: (user: UserDto) => void }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";
      const payload =
        mode === "register" ? { name, email, password } : { email, password };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Authentication failed.");
        return;
      }
      onSuccess(data.user);
    } catch {
      setError("Network error while contacting the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-12 lg:grid-cols-2 lg:items-center">
      <div className="space-y-6">
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          <Sparkles className="h-3.5 w-3.5" />
          Synchronized Multimodal Gaming Clipping
        </div>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Turn long gaming VODs into punchy 9:16 vertical highlights.
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
          Paste a YouTube link to inspect permitted metadata, upload your authorized
          recording, and let our background worker detect high-impact plays using
          speech timestamps, audio reaction contrast, gameplay motion, scene cuts,
          and face-cam framing.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-card/70 p-3.5">
            <Video className="mb-2 h-4 w-4 text-primary" />
            <p className="text-sm font-medium">Honest Source Ingestion</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Never scrapes or downloads YouTube videos. Processes your authorized
              files securely in isolated worker jobs.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card/70 p-3.5">
            <Lock className="mb-2 h-4 w-4 text-emerald-400" />
            <p className="text-sm font-medium">Private Per-User Workspace</p>
            <p className="mt-1 text-xs text-muted-foreground">
              All uploads, candidate clips, captions, and rendered MP4 exports are
              scoped strictly to your account.
            </p>
          </div>
        </div>
      </div>

      <Card className="border-border/80 bg-card/95 shadow-xl">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <Clapperboard className="h-5 w-5 text-primary" />
            <CardTitle>
              {mode === "register" ? "Create your ClipForge account" : "Sign in to ClipForge"}
            </CardTitle>
          </div>
          <CardDescription>
            {mode === "register"
              ? "Your jobs, authorized uploads, and rendered MP4s stay private to your account."
              : "Sign in to resume your clip jobs and download vertical exports."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-5 grid grid-cols-2 rounded-lg bg-secondary/70 p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => {
                setMode("register");
                setError(null);
              }}
              className={`rounded-md py-2 transition ${
                mode === "register"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Create Account
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("login");
                setError(null);
              }}
              className={`rounded-md py-2 transition ${
                mode === "login"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Sign In
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "register" && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Display Name
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="AlexPlays"
                  required
                  minLength={2}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Email</label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Password
              </label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "register" ? "At least 8 characters" : "••••••••"}
                required
                minLength={mode === "register" ? 8 : 1}
              />
            </div>

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting
                ? "Please wait..."
                : mode === "register"
                  ? "Create Account & Enter Studio"
                  : "Sign In"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
