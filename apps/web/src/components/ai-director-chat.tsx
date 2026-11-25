"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  KeyRound,
  Loader2,
  Play,
  Send,
  Trash2,
  Wrench,
} from "lucide-react";
import { AI_PROVIDER_CATALOG } from "@clipforge/core/client";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AiProviderDto, JobChatMessageDto } from "@/components/types";
import { cn, formatTime } from "@/lib/utils";

const STARTER_PROMPTS = [
  "Find the top 3 funniest or highest-energy moments in this video and create 30s clips",
  "Switch all selected clips to Split Cam Top with Bold Gaming captions",
  "Search the transcript for key reactions and trim tighter around the payoff",
  "Review my current clips, keep the strongest ones selected, and discard weak ones",
];

export function AiDirectorChat({
  jobId,
  aiProviders,
  initialMessages,
  selectedClipId,
  hasAnalysisData,
  onJobUpdated,
  onSelectClip,
}: {
  jobId: string;
  aiProviders: AiProviderDto[];
  initialMessages: JobChatMessageDto[];
  selectedClipId: string | null;
  hasAnalysisData: boolean;
  onJobUpdated: () => Promise<void>;
  onSelectClip: (clipId: string, seekSec?: number) => void;
}) {
  const enabledProviders = aiProviders.filter((p) => p.isEnabled);
  const defaultProvider =
    enabledProviders.find((p) => p.isDefault) ?? enabledProviders[0] ?? null;

  const [selectedProviderId, setSelectedProviderId] = useState<string>(
    defaultProvider?.id ?? "",
  );
  const [messages, setMessages] = useState<JobChatMessageDto[]>(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedProviderId && defaultProvider) {
      setSelectedProviderId(defaultProvider.id);
    }
  }, [defaultProvider, selectedProviderId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length, sending]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setError(null);
    setSending(true);

    const optimisticUser: JobChatMessageDto = {
      id: `temp_${Date.now()}`,
      jobId,
      role: "user",
      content: trimmed,
      provider: null,
      model: null,
      actionsJson: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);
    setInput("");

    try {
      const res = await fetch(`/api/jobs/${jobId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          providerId: selectedProviderId || undefined,
          selectedClipId: selectedClipId || undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setMessages((prev) => prev.filter((m) => m.id !== optimisticUser.id));
        setInput(trimmed);
        setError(data.error ?? "AI agent request failed.");
        return;
      }

      setMessages((prev) => [
        ...prev.filter((m) => m.id !== optimisticUser.id),
        data.userMessage,
        data.assistantMessage,
      ]);

      if (data.jobUpdated) {
        await onJobUpdated();
      }
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUser.id));
      setInput(trimmed);
      setError("Network error while contacting AI provider.");
    } finally {
      setSending(false);
    }
  }

  async function handleClear() {
    setClearing(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/chat`, { method: "DELETE" });
      if (res.ok) {
        setMessages([]);
      }
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Top Bar: Connected Model Switcher + Manage Keys */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/35 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Bot className="h-4 w-4 text-accent" />
          <span className="text-xs font-medium text-foreground">AI Director</span>
          {enabledProviders.length > 0 ? (
            <select
              value={selectedProviderId}
              onChange={(e) => setSelectedProviderId(e.target.value)}
              aria-label="Select AI model"
              className="h-7 rounded-md border border-border bg-card px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {enabledProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {AI_PROVIDER_CATALOG[p.provider].shortName}: {p.model}
                </option>
              ))}
            </select>
          ) : (
            <Badge variant="warning">No API key connected</Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={clearing}
              onClick={handleClear}
              className="h-7 px-2 text-xs"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
          <Link
            href="/settings/ai"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 px-2.5 text-xs")}
          >
            <KeyRound className="h-3.5 w-3.5" />
            {enabledProviders.length > 0 ? "Manage Keys" : "Connect Key"}
          </Link>
        </div>
      </div>

      {enabledProviders.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/35 bg-primary/10 p-3.5 text-xs">
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              Connect Claude, ChatGPT, OpenRouter, or a local model to chat with this video
            </p>
            <p className="text-muted-foreground">
              Your key stays encrypted on your local system and lets the AI agent search this video&apos;s transcript, find moments, create/trim clips, and style captions for you.
            </p>
          </div>
          <Link
            href="/settings/ai"
            className={buttonVariants({ variant: "default", size: "sm" })}
          >
            <KeyRound className="h-3.5 w-3.5" />
            Connect AI Key
          </Link>
        </div>
      )}

      {!hasAnalysisData && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            Analysis is still running or incomplete. Wait for transcript and scene events before asking the agent to find moments.
          </span>
        </div>
      )}

      {/* Conversation History */}
      <div className="max-h-[420px] min-h-[220px] space-y-3 overflow-y-auto rounded-lg border border-border bg-background/60 p-3.5">
        {messages.length === 0 ? (
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">
              Ask your connected AI model to locate exact moments from this video or edit your clips automatically:
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={enabledProviders.length === 0 || sending}
                  onClick={() => void sendMessage(prompt)}
                  className="cursor-pointer rounded-lg border border-border bg-card p-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "flex flex-col gap-1.5",
                msg.role === "user" ? "items-end" : "items-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[90%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "border border-border bg-card text-foreground",
                )}
              >
                {msg.role === "assistant" && msg.model && (
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Bot className="h-3 w-3 text-accent" />
                    <span className="font-mono">{msg.model}</span>
                  </div>
                )}
                <div className="whitespace-pre-wrap">{msg.content}</div>

                {msg.role === "assistant" &&
                  Array.isArray(msg.actionsJson) &&
                  msg.actionsJson.length > 0 && (
                    <div className="mt-2.5 space-y-1.5 border-t border-border/80 pt-2">
                      <p className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                        <Wrench className="h-3 w-3" />
                        Actions executed
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {msg.actionsJson.map((act, idx) => (
                          <div
                            key={`${msg.id}_act_${idx}`}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
                              act.status === "ok"
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                : "border-destructive/30 bg-destructive/10 text-rose-300",
                            )}
                          >
                            <CheckCircle2 className="h-3 w-3 shrink-0" />
                            <span>{act.summary}</span>
                            {act.clipId && (
                              <button
                                type="button"
                                onClick={() => onSelectClip(act.clipId!, act.startSec)}
                                className="ml-1 inline-flex items-center gap-0.5 rounded bg-background/60 px-1.5 py-0.5 font-medium text-primary hover:bg-background"
                              >
                                <Play className="h-2.5 w-2.5" />
                                {act.startSec !== undefined ? formatTime(act.startSec) : "Open"}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            </div>
          ))
        )}

        {sending && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            <span>Searching transcript, inspecting timeline peaks, and applying edits...</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-rose-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void sendMessage(input);
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={enabledProviders.length === 0 || sending}
          placeholder={
            enabledProviders.length > 0
              ? "Ask your AI agent to find moments, trim clips, change layout, or queue exports"
              : "Connect an AI API key to start chatting"
          }
          className="flex h-9 flex-1 rounded-lg border border-border bg-secondary/50 px-3 text-xs text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
        <Button
          type="submit"
          size="sm"
          disabled={enabledProviders.length === 0 || sending || !input.trim()}
          className="h-9 px-3.5"
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send
        </Button>
      </form>
    </div>
  );
}
