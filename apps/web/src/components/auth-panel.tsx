"use client";

import { useState } from "react";
import { Bot, Clapperboard, KeyRound, Lock, Video } from "lucide-react";
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
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 lg:grid-cols-12 lg:items-center sm:px-6">
      <div className="space-y-6 lg:col-span-7">
        <p className="text-xs font-medium text-primary">
          Local-first gaming &amp; stream clipping studio
        </p>
        <h1 className="text-3xl font-medium tracking-tight text-foreground sm:text-5xl sm:leading-[1.08]">
          Turn long streams and VODs into edited 9:16 vertical clips
        </h1>
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Paste a YouTube, Twitch, or media link, analyze speech and gameplay peaks locally, and chat with your own Claude, ChatGPT, or OpenRouter model to find exact moments and apply edits.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-card p-4">
            <Video className="mb-2.5 h-4 w-4 text-primary" />
            <p className="text-sm font-medium text-foreground">Direct Media Ingest</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Scrape VODs, monitor live HLS streams, or upload recordings into isolated jobs
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <Bot className="mb-2.5 h-4 w-4 text-accent" />
            <p className="text-sm font-medium text-foreground">AI Video Director</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Chat with your video to locate moments, trim boundaries, and style 9:16 layouts
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <KeyRound className="mb-2.5 h-4 w-4 text-emerald-400" />
            <p className="text-sm font-medium text-foreground">Bring Your Own Keys</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Connect Claude, ChatGPT, OpenRouter, Gemini, Groq, or local Ollama models
            </p>
          </div>
        </div>
      </div>

      <Card className="lg:col-span-5">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <Clapperboard className="h-5 w-5 text-primary" />
            <CardTitle>
              {mode === "register" ? "Create your ClipForge account" : "Sign in to ClipForge"}
            </CardTitle>
          </div>
          <CardDescription>
            {mode === "register"
              ? "Your projects, encrypted API keys, and rendered MP4 exports stay private to your workspace."
              : "Sign in to resume your clip projects and AI workflows."}
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
              className={`cursor-pointer rounded-md py-2 transition-colors ${
                mode === "register"
                  ? "bg-card text-foreground"
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
              className={`cursor-pointer rounded-md py-2 transition-colors ${
                mode === "login"
                  ? "bg-card text-foreground"
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
                  Display name
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
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-rose-300">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              <Lock className="h-3.5 w-3.5" />
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
