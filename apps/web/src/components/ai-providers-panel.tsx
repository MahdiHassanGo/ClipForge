"use client";

import { useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  Server,
  Star,
  Trash2,
  Zap,
} from "lucide-react";
import {
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_LIST,
  type AiProviderType,
} from "@clipforge/core/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { AiProviderDto } from "@/components/types";
import { cn } from "@/lib/utils";

export function AiProvidersPanel({
  initialProviders,
  onChange,
}: {
  initialProviders: AiProviderDto[];
  onChange?: (providers: AiProviderDto[]) => void;
}) {
  const [providers, setProviders] = useState<AiProviderDto[]>(initialProviders);
  const [selectedProvider, setSelectedProvider] = useState<AiProviderType>("anthropic");
  const [label, setLabel] = useState("Anthropic Claude");
  const [model, setModel] = useState(AI_PROVIDER_CATALOG.anthropic.defaultModel);
  const [customModel, setCustomModel] = useState("");
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [isDefault, setIsDefault] = useState(initialProviders.length === 0);

  const [saving, setSaving] = useState(false);
  const [testingDraft, setTestingDraft] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const activeCatalog = AI_PROVIDER_CATALOG[selectedProvider];
  const effectiveModel = useCustomModel ? customModel.trim() : model;

  function selectProviderType(next: AiProviderType) {
    const entry = AI_PROVIDER_CATALOG[next];
    setSelectedProvider(next);
    setLabel(entry.name);
    setModel(entry.defaultModel);
    setCustomModel("");
    setUseCustomModel(false);
    setBaseUrl(next === "custom" ? entry.defaultBaseUrl : "");
    setFeedback(null);
  }

  function updateProvidersList(next: AiProviderDto[]) {
    setProviders(next);
    onChange?.(next);
  }

  async function refreshProviders() {
    const res = await fetch("/api/ai/providers");
    if (res.ok) {
      const data = await res.json();
      updateProvidersList(data.providers ?? []);
    }
  }

  async function handleTestDraft() {
    setFeedback(null);
    if (!effectiveModel) {
      setFeedback({ type: "error", text: "Choose or enter a model ID first." });
      return;
    }
    if (activeCatalog.requiresApiKey && !apiKey.trim()) {
      setFeedback({ type: "error", text: "Enter an API key to test this provider." });
      return;
    }

    setTestingDraft(true);
    try {
      const res = await fetch("/api/ai/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          model: effectiveModel,
          baseUrl: baseUrl.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: "error", text: data.error ?? "Connection test failed." });
        return;
      }
      setFeedback({
        type: "success",
        text: `Connected to ${data.modelUsed} in ${data.latencyMs}ms`,
      });
    } catch {
      setFeedback({ type: "error", text: "Network error while testing connection." });
    } finally {
      setTestingDraft(false);
    }
  }

  async function handleSaveProvider(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);

    if (!effectiveModel) {
      setFeedback({ type: "error", text: "Model ID is required." });
      return;
    }
    if (activeCatalog.requiresApiKey && !apiKey.trim()) {
      setFeedback({ type: "error", text: "API key is required for this provider." });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/ai/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          label: label.trim() || activeCatalog.name,
          model: effectiveModel,
          baseUrl: baseUrl.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
          isDefault,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: "error", text: data.error ?? "Could not save provider." });
        return;
      }

      setApiKey("");
      setShowKey(false);
      await refreshProviders();
      setFeedback({
        type: "success",
        text: `Saved ${data.provider.label} (${data.provider.model}) encrypted in local storage`,
      });
    } catch {
      setFeedback({ type: "error", text: "Network error while saving AI key." });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestSaved(id: string) {
    setTestingId(id);
    setFeedback(null);
    try {
      const res = await fetch("/api/ai/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: "error", text: data.error ?? "Connection test failed." });
        return;
      }
      setFeedback({
        type: "success",
        text: `Verified ${data.modelUsed} (${data.latencyMs}ms)`,
      });
    } catch {
      setFeedback({ type: "error", text: "Network error while verifying saved key." });
    } finally {
      setTestingId(null);
    }
  }

  async function handleSetDefault(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/ai/providers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: true, isEnabled: true }),
      });
      if (res.ok) {
        await refreshProviders();
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/ai/providers/${id}`, { method: "DELETE" });
      if (res.ok) {
        await refreshProviders();
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      {/* Left: Add / Connect Provider Form */}
      <Card className="lg:col-span-7">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            Connect an AI model key
          </CardTitle>
          <CardDescription>
            Keys are encrypted with AES-256-GCM on your local system and used directly by the Video Director chat to search transcripts, find moments, trim clips, and queue exports.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveProvider} className="space-y-4">
            {/* Provider Grid */}
            <div className="space-y-2">
              <span className="text-xs font-medium text-muted-foreground">Provider</span>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {AI_PROVIDER_LIST.map((entry) => {
                  const active = selectedProvider === entry.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => selectProviderType(entry.id)}
                      className={cn(
                        "cursor-pointer rounded-lg border p-2.5 text-left transition-colors",
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-secondary/35 text-muted-foreground hover:border-border/90 hover:text-foreground",
                      )}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-medium text-foreground">
                          {entry.shortName}
                        </span>
                        {entry.id === "custom" ? (
                          <Server className="h-3.5 w-3.5 text-accent" />
                        ) : (
                          <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </div>
                      <p className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
                        {entry.defaultModel}
                      </p>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">{activeCatalog.description}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-xs">
                <span className="font-medium text-muted-foreground">Connection label</span>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="My Claude Sonnet Key"
                  required
                />
              </label>

              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-muted-foreground">Model</span>
                  <button
                    type="button"
                    onClick={() => setUseCustomModel((v) => !v)}
                    className="text-[11px] text-primary hover:underline"
                  >
                    {useCustomModel ? "Pick preset" : "Custom model ID"}
                  </button>
                </div>
                {useCustomModel ? (
                  <Input
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="e.g. anthropic/claude-opus-4"
                    className="font-mono text-xs"
                    required
                  />
                ) : (
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="flex h-9 w-full rounded-lg border border-border bg-secondary/50 px-3 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {activeCatalog.suggestedModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} ({m.id})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div className="space-y-1.5 text-xs">
              <span className="font-medium text-muted-foreground">
                API key {activeCatalog.requiresApiKey ? "(required)" : "(optional for local models)"}
              </span>
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={activeCatalog.keyPlaceholder}
                  className="pr-10 font-mono text-xs"
                  required={activeCatalog.requiresApiKey}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <label className="block space-y-1.5 text-xs">
              <span className="font-medium text-muted-foreground">
                Endpoint Base URL {selectedProvider === "custom" ? "(required for local server)" : "(optional override)"}
              </span>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={activeCatalog.defaultBaseUrl}
                className="font-mono text-xs"
              />
            </label>

            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              <span>Set as default model for Video Director chat</span>
            </label>

            {feedback && (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs",
                  feedback.type === "success"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-destructive/40 bg-destructive/10 text-rose-300",
                )}
              >
                {feedback.type === "success" && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                <span>{feedback.text}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving key...
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4" />
                    Save & Connect Key
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={testingDraft}
                onClick={handleTestDraft}
              >
                {testingDraft ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Testing...
                  </>
                ) : (
                  <>
                    <Zap className="h-4 w-4" />
                    Test Connection
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Right: Saved Connections */}
      <Card className="lg:col-span-5">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Connected keys</span>
            <Badge variant="secondary" className="tabular-nums">
              {providers.length} saved
            </Badge>
          </CardTitle>
          <CardDescription>
            Switch between Claude, ChatGPT, OpenRouter, or local models anytime inside any video project.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {providers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              No AI keys connected yet. Add Claude, ChatGPT, OpenRouter, or a local Ollama endpoint on the left to enable the AI Video Director chat.
            </div>
          ) : (
            <div className="space-y-3">
              {providers.map((item) => {
                const meta = AI_PROVIDER_CATALOG[item.provider];
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "rounded-lg border p-3.5 transition-colors",
                      item.isDefault
                        ? "border-primary/60 bg-primary/5"
                        : "border-border bg-secondary/25",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={item.isDefault ? "warning" : "default"}>
                            {meta.shortName}
                          </Badge>
                          {item.isDefault && (
                            <Badge variant="accent">Default</Badge>
                          )}
                        </div>
                        <p className="truncate text-sm font-medium text-foreground">
                          {item.label}
                        </p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {item.model}
                        </p>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          Key: {item.keyPreview}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        {!item.isDefault && (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            title="Set as default"
                            disabled={busyId === item.id}
                            onClick={() => void handleSetDefault(item.id)}
                          >
                            <Star className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={testingId === item.id}
                          onClick={() => void handleTestSaved(item.id)}
                        >
                          {testingId === item.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            "Test"
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          title="Remove key"
                          disabled={busyId === item.id}
                          onClick={() => void handleDelete(item.id)}
                          className="hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
