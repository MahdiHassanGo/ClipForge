"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  Film,
  FolderOpen,
  HardDrive,
  Info,
  Link2,
  Loader2,
  Radio,
  Settings2,
  Trash2,
  Video,
} from "lucide-react";
import {
  SUPPORTED_CAPTION_LANGUAGES,
  type JobStatus,
  type StreamType,
  type YouTubeMetadataResult,
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
import { Progress } from "@/components/ui/progress";
import { Navbar } from "@/components/navbar";
import { AuthPanel } from "@/components/auth-panel";
import type {
  CapabilitiesDto,
  ClipJobSummaryDto,
  UserDto,
} from "@/components/types";
import { formatTime } from "@/lib/utils";

function streamTypeLabel(st: StreamType): { label: string; variant: "default" | "warning" | "secondary" | "accent" } {
  switch (st) {
    case "live_stream":
      return { label: "Live Stream", variant: "warning" };
    case "archived_stream":
      return { label: "Archived Stream", variant: "accent" };
    case "regular_video":
      return { label: "Regular Video", variant: "default" };
    case "upcoming_stream":
      return { label: "Upcoming Stream", variant: "warning" };
    default:
      return { label: "Stream Type Unknown", variant: "secondary" };
  }
}

function jobStatusBadge(status: JobStatus): {
  label: string;
  variant: "default" | "secondary" | "success" | "warning" | "destructive" | "accent";
} {
  switch (status) {
    case "queued":
      return { label: "Awaiting Upload", variant: "warning" };
    case "live_monitoring":
      return { label: "Live Monitoring", variant: "accent" };
    case "uploading":
      return { label: "Uploading", variant: "default" };
    case "analyzing":
      return { label: "Analyzing", variant: "accent" };
    case "candidates_ready":
      return { label: "Candidates Ready", variant: "success" };
    case "rendering":
      return { label: "Rendering 9:16", variant: "default" };
    case "complete":
      return { label: "Exports Ready", variant: "success" };
    case "failed":
      return { label: "Failed", variant: "destructive" };
    case "cancelled":
      return { label: "Cancelled", variant: "secondary" };
  }
}

export function DashboardClient({
  initialUser,
  initialCapabilities,
}: {
  initialUser: UserDto | null;
  initialCapabilities: CapabilitiesDto;
}) {
  const router = useRouter();
  const [user, setUser] = useState<UserDto | null>(initialUser);
  const [capabilities] = useState<CapabilitiesDto>(initialCapabilities);

  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspected, setInspected] = useState<{
    metadata: YouTubeMetadataResult;
    ingestion: { providerName: string; requiresUserUpload: boolean; reason: string };
    isLiveStream?: boolean;
    canLiveIngest?: boolean;
  } | null>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [minClipSec, setMinClipSec] = useState(
    capabilities.defaultAnalysisConfig.minClipSec,
  );
  const [maxClipSec, setMaxClipSec] = useState(
    capabilities.defaultAnalysisConfig.maxClipSec,
  );
  const [targetClipSec, setTargetClipSec] = useState(
    capabilities.defaultAnalysisConfig.targetClipSec,
  );
  const [scoreThreshold, setScoreThreshold] = useState(
    capabilities.defaultAnalysisConfig.scoreThreshold,
  );
  const [captionLanguage, setCaptionLanguage] = useState(
    capabilities.defaultAnalysisConfig.captionLanguage,
  );

  const [storageInfo, setStorageInfo] = useState<{
    currentStorageDir: string;
    currentTempDir: string;
    currentClipsDir: string;
    currentFreeBytes: number;
    currentFreeFormatted: string;
    isLowSpace: boolean;
    volumes: Array<{
      name: string;
      mountPath: string;
      clipForgePath: string;
      freeBytes: number;
      totalBytes: number;
      freeFormatted: string;
      isLowSpace: boolean;
      isRecommended: boolean;
    }>;
  } | null>(null);
  const [selectedStoragePath, setSelectedStoragePath] = useState<string>("");
  const [customPathInput, setCustomPathInput] = useState<string>("");
  const [updatingStorage, setUpdatingStorage] = useState(false);
  const [storageSuccessMsg, setStorageSuccessMsg] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [jobs, setJobs] = useState<ClipJobSummaryDto[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);

  async function fetchStorageInfo() {
    try {
      const res = await fetch("/api/system/storage");
      if (res.ok) {
        const data = await res.json();
        setStorageInfo(data);
        if (!selectedStoragePath) {
          setSelectedStoragePath(data.currentStorageDir);
        }
      }
    } catch {
      // ignore
    }
  }

  async function handleApplyStorage(targetPath: string) {
    setUpdatingStorage(true);
    setStorageSuccessMsg(null);
    try {
      const res = await fetch("/api/system/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageDir: targetPath }),
      });
      const data = await res.json();
      if (res.ok) {
        setStorageSuccessMsg(`Storage saved: ${data.storageDir} (${data.freeFormatted} available)`);
        setSelectedStoragePath(data.storageDir);
        await fetchStorageInfo();
      }
    } catch {
      // ignore
    } finally {
      setUpdatingStorage(false);
    }
  }

  async function fetchJobs() {
    if (!user) return;
    setLoadingJobs(true);
    try {
      const res = await fetch("/api/jobs");
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs ?? []);
      }
    } finally {
      setLoadingJobs(false);
    }
  }

  useEffect(() => {
    if (!user) return;
    void fetchJobs();
    void fetchStorageInfo();
    const timer = setInterval(() => {
      void fetch("/api/jobs")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.jobs) setJobs(data.jobs);
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function handleInspect(e: React.FormEvent) {
    e.preventDefault();
    setInspectError(null);
    setInspected(null);
    setInspecting(true);
    try {
      const res = await fetch("/api/youtube/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: youtubeUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setInspectError(data.error ?? "Invalid YouTube URL.");
        return;
      }
      setInspected({
        metadata: data.metadata,
        ingestion: data.ingestion,
        isLiveStream: data.isLiveStream,
        canLiveIngest: data.canLiveIngest,
      });
    } catch {
      setInspectError("Failed to inspect YouTube URL. Please check your connection.");
    } finally {
      setInspecting(false);
    }
  }

  async function handleCreateProject(asLive = false) {
    if (!inspected) return;
    setCreating(true);
    setInspectError(null);
    try {
      const isLive = asLive || Boolean(inspected.isLiveStream);
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          youtubeUrl: inspected.metadata.canonicalUrl,
          isLiveStream: isLive,
          analysisConfig: {
            minClipSec: Number(minClipSec),
            maxClipSec: Number(maxClipSec),
            targetClipSec: Number(targetClipSec),
            scoreThreshold: Number(scoreThreshold),
            maxCandidates: capabilities.defaultAnalysisConfig.maxCandidates,
            captionLanguage,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setInspectError(data.error ?? "Could not create clip job.");
        return;
      }
      router.push(`/jobs/${data.job.id}`);
    } catch {
      setInspectError("Network error while creating project.");
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteJob(jobId: string) {
    const res = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    if (res.ok) {
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
    }
  }

  if (!user) {
    return (
      <div className="min-h-screen">
        <Navbar user={null} capabilities={capabilities} />
        <AuthPanel
          onSuccess={(u) => {
            setUser(u);
          }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-16">
      <Navbar user={user} capabilities={capabilities} />

      <main className="mx-auto max-w-7xl space-y-8 px-4 pt-8 sm:px-6">
        {/* Storage safety alert when internal space is low */}
        {storageInfo?.isLowSpace && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <div>
                <p className="font-semibold text-rose-100">
                  Storage Warning: Your current download drive only has {storageInfo.currentFreeFormatted} free space left!
                </p>
                <p className="mt-0.5 text-rose-200/80">
                  Fetching long video streams or rendering vertical clips on this drive may run out of space.
                  Switch to an external drive to save all clips safely.
                </p>
              </div>
            </div>
            {storageInfo.volumes.find((v) => v.isRecommended) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  handleApplyStorage(storageInfo.volumes.find((v) => v.isRecommended)!.clipForgePath)
                }
                disabled={updatingStorage}
                className="border-rose-500/40 text-xs text-rose-100 hover:bg-rose-500/20"
              >
                Switch to {storageInfo.volumes.find((v) => v.isRecommended)!.name} (
                {storageInfo.volumes.find((v) => v.isRecommended)!.freeFormatted} free)
              </Button>
            )}
          </div>
        )}

        {/* Honest capability & setup status bar */}
        {(!capabilities.youtubeApiConfigured || !capabilities.whisperConfigured) && (
          <div className="flex flex-wrap items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="space-y-1">
              <p className="font-medium text-amber-100">
                Optional API integrations not configured — upload-based clipping works right now
              </p>
              <p className="text-amber-200/85">
                {!capabilities.youtubeApiConfigured &&
                  "Set free YOUTUBE_API_KEY in .env to classify live vs. archived streams and duration (currently using free official YouTube oEmbed). "}
                {!capabilities.whisperConfigured &&
                  "Add a free GROQ_API_KEY (recommended) or local whisper.cpp model in .env for automatic word-level captions (currently using free audio/motion/scene/face-cam analysis + manual caption review)."}
              </p>
            </div>
          </div>
        )}

        {/* Step 1: Paste YouTube URL & Inspect Metadata */}
        <Card className="border-border/80 bg-card">
          <CardHeader className="pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <Link2 className="h-4 w-4 text-primary" />
                  New Clip Project
                </CardTitle>
                <CardDescription className="mt-1 text-xs">
                  Paste any YouTube video, archived livestream, Twitch VOD, podcast audio, or video link to scrape and generate vertical clips automatically.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowSettings((v) => !v)}
                className="text-xs"
              >
                <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
                Clip Settings
              </Button>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            <form onSubmit={handleInspect} className="flex flex-col gap-2.5 sm:flex-row">
              <Input
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                placeholder="Paste YouTube, Twitch, podcast, or stream link (e.g. https://www.youtube.com/watch?v=...)"
                className="flex-1 text-xs sm:text-sm"
                required
              />
              <Button type="submit" disabled={inspecting} className="sm:w-36 text-xs font-medium">
                {inspecting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Inspecting...
                  </>
                ) : (
                  <>
                    Inspect URL
                    <ArrowRight className="h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            </form>

            {showSettings && (
              <div className="grid gap-3 rounded-md border border-border/70 bg-secondary/20 p-3.5 sm:grid-cols-2 lg:grid-cols-5">
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Min Clip</span>
                  <Input
                    type="number"
                    min={5}
                    max={120}
                    value={minClipSec}
                    onChange={(e) => setMinClipSec(Number(e.target.value))}
                    className="h-8 text-xs tabular-nums"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Target Clip</span>
                  <Input
                    type="number"
                    min={10}
                    max={120}
                    value={targetClipSec}
                    onChange={(e) => setTargetClipSec(Number(e.target.value))}
                    className="h-8 text-xs tabular-nums"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Max Clip</span>
                  <Input
                    type="number"
                    min={10}
                    max={180}
                    value={maxClipSec}
                    onChange={(e) => setMaxClipSec(Number(e.target.value))}
                    className="h-8 text-xs tabular-nums"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Threshold</span>
                  <Input
                    type="number"
                    step={0.05}
                    min={0.1}
                    max={0.95}
                    value={scoreThreshold}
                    onChange={(e) => setScoreThreshold(Number(e.target.value))}
                    className="h-8 text-xs tabular-nums"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Captions</span>
                  <select
                    value={captionLanguage}
                    onChange={(e) => setCaptionLanguage(e.target.value)}
                    className="flex h-8 w-full rounded-md border border-border/80 bg-secondary/30 px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                  >
                    {SUPPORTED_CAPTION_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="sm:col-span-2 lg:col-span-5 flex flex-col gap-2 rounded border border-border/70 bg-secondary/30 p-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-0.5">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <HardDrive className="h-3.5 w-3.5 text-primary" /> Custom Storage & Clip Destination
                    </span>
                    <p className="text-[11px] text-muted-foreground truncate">
                      Current: <code className="font-mono text-foreground">{storageInfo?.currentStorageDir}</code>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      value={customPathInput}
                      onChange={(e) => setCustomPathInput(e.target.value)}
                      placeholder="/Volumes/YourExternalDrive/clips"
                      className="h-7 w-60 text-xs font-mono"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-7 text-xs shrink-0"
                      disabled={updatingStorage || !customPathInput.trim()}
                      onClick={() => handleApplyStorage(customPathInput.trim())}
                    >
                      {updatingStorage ? <Loader2 className="h-3 w-3 animate-spin" /> : "Set Path"}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {inspectError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{inspectError}</span>
              </div>
            )}

            {inspected && (
              <div className="rounded-lg border border-border/80 bg-secondary/20 p-4">
                <div className="flex flex-col gap-4 md:flex-row">
                  {inspected.metadata.thumbnailUrl && (
                    <img
                      src={inspected.metadata.thumbnailUrl}
                      alt={inspected.metadata.title ?? "YouTube video thumbnail"}
                      className="h-28 w-full rounded-md border border-border/80 object-cover md:w-48"
                    />
                  )}
                  <div className="flex-1 space-y-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="default" className="text-[11px]">
                        ID: {inspected.metadata.videoId}
                      </Badge>
                      <Badge variant={streamTypeLabel(inspected.metadata.streamType).variant} className="text-[11px]">
                        <Radio className="h-3 w-3" />
                        {streamTypeLabel(inspected.metadata.streamType).label}
                      </Badge>
                      {inspected.metadata.durationSec && (
                        <Badge variant="secondary" className="text-[11px] tabular-nums">
                          <Clock className="h-3 w-3" />
                          {formatTime(inspected.metadata.durationSec)}
                        </Badge>
                      )}
                    </div>

                    <div>
                      <h3 className="text-sm font-medium text-foreground">
                        {inspected.metadata.title ?? `YouTube Video (${inspected.metadata.videoId})`}
                      </h3>
                      {inspected.metadata.channelTitle && (
                        <p className="text-xs text-muted-foreground">
                          {inspected.metadata.channelTitle}
                        </p>
                      )}
                    </div>

                    {inspected.isLiveStream || inspected.metadata.streamType === "live_stream" ? (
                      <div className="rounded border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-200/90">
                        <div className="flex items-center gap-2 font-medium text-amber-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                          Live Stream Detected — Real-time Ingestion Ready
                        </div>
                        <p className="mt-1 text-muted-foreground">
                          ClipForge monitors rolling HLS audio and chat velocity spikes to slice clutch highlights automatically.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs leading-relaxed text-emerald-200">
                        <div className="flex items-center gap-2 font-medium text-emerald-300">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Direct Media Ingestion Ready — No Manual Upload Needed
                        </div>
                        <p className="mt-1 text-emerald-300/80">
                          ClipForge will scrape the media directly from the URL, transcribe speech, detect highlights, and generate 9:16 vertical clips automatically.
                        </p>
                      </div>
                    )}

                    {/* Storage Destination & Space Safeguard */}
                    <div className="rounded-md border border-border/80 bg-secondary/35 p-3 space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 font-medium text-foreground">
                          <HardDrive className="h-3.5 w-3.5 text-primary" />
                          Download & Clip Destination (Storage Safeguard):
                        </span>
                        {storageInfo && (
                          <Badge variant={storageInfo.isLowSpace ? "destructive" : "secondary"} className="text-[10px]">
                            {storageInfo.currentFreeFormatted} free
                          </Badge>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {storageInfo?.volumes.map((vol) => {
                          const isActive =
                            storageInfo.currentStorageDir.startsWith(vol.clipForgePath) ||
                            storageInfo.currentStorageDir.startsWith(vol.mountPath);
                          return (
                            <Button
                              key={vol.mountPath}
                              type="button"
                              size="sm"
                              variant={isActive ? "default" : "outline"}
                              className="h-7 text-[11px] px-2.5"
                              onClick={() => handleApplyStorage(vol.clipForgePath)}
                              disabled={updatingStorage}
                            >
                              <FolderOpen className="h-3 w-3 mr-1" />
                              {vol.name} ({vol.freeFormatted} free)
                              {vol.isRecommended && <span className="ml-1 text-[9px] opacity-75">★ Rec</span>}
                            </Button>
                          );
                        })}
                      </div>

                      <div className="text-[11px] text-muted-foreground flex flex-wrap items-center justify-between gap-2 pt-0.5">
                        <span className="truncate">
                          Saving to: <code className="text-foreground font-mono">{storageInfo?.currentStorageDir}</code>
                        </span>
                      </div>

                      {storageSuccessMsg && (
                        <p className="text-[11px] text-emerald-400 font-medium">✓ {storageSuccessMsg}</p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {inspected.isLiveStream || inspected.metadata.streamType === "live_stream" ? (
                        <>
                          <Button
                            onClick={() => handleCreateProject(true)}
                            disabled={creating}
                            size="sm"
                          >
                            {creating ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Starting Live Monitor...
                              </>
                            ) : (
                              <>
                                <Radio className="h-3.5 w-3.5" />
                                Monitor Live Stream
                                <ArrowRight className="h-3.5 w-3.5" />
                              </>
                            )}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleCreateProject(false)}
                            disabled={creating}
                          >
                            Scrape as VOD / Archive
                          </Button>
                        </>
                      ) : (
                        <Button onClick={() => handleCreateProject(false)} disabled={creating} size="sm">
                          {creating ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Scraping & Launching Studio...
                            </>
                          ) : (
                            <>
                              Scrape & Generate Clips
                              <ArrowRight className="h-3.5 w-3.5" />
                            </>
                          )}
                        </Button>
                      )}
                      <a
                        href={inspected.metadata.canonicalUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Source Link
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Jobs List */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold tracking-tight text-foreground uppercase tracking-wider text-muted-foreground">
                Recent Projects
              </h2>
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">{jobs.length} projects</span>
          </div>

          {loadingJobs && jobs.length === 0 ? (
            <Card>
              <CardContent className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading projects...
              </CardContent>
            </Card>
          ) : jobs.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Film className="mb-2.5 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm font-medium text-foreground">No clip projects yet</p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  Paste a YouTube URL above to begin clipping moments.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {jobs.map((job) => {
                const badge = jobStatusBadge(job.status);
                const stream = streamTypeLabel(job.youtubeStreamType);
                const inFlight =
                  job.status === "uploading" ||
                  job.status === "analyzing" ||
                  job.status === "rendering" ||
                  job.status === "live_monitoring";

                return (
                  <Card
                    key={job.id}
                    className="border-border/80 bg-card hover:border-border transition-colors"
                  >
                    <CardContent className="p-3.5">
                      <div className="flex gap-3.5">
                        {job.youtubeThumbnailUrl ? (
                          <img
                            src={job.youtubeThumbnailUrl}
                            alt={job.youtubeTitle ?? job.youtubeVideoId}
                            className="h-20 w-32 shrink-0 rounded-md border border-border/80 object-cover"
                          />
                        ) : (
                          <div className="flex h-20 w-32 shrink-0 items-center justify-center rounded-md border border-border/80 bg-secondary/40">
                            <Video className="h-5 w-5 text-muted-foreground" />
                          </div>
                        )}

                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={badge.variant} className="text-[10px] py-0">{badge.label}</Badge>
                            {job.isLiveStream && (
                              <Badge variant="warning" className="text-[10px] py-0">
                                <span className="h-1 w-1 rounded-full bg-rose-500 mr-1" />
                                Live HLS
                              </Badge>
                            )}
                          </div>

                          <Link
                            href={`/jobs/${job.id}`}
                            className="block truncate text-sm font-medium text-foreground hover:text-primary transition-colors"
                          >
                            {job.youtubeTitle ?? `YouTube Video (${job.youtubeVideoId})`}
                          </Link>

                          <p className="truncate text-xs text-muted-foreground tabular-nums">
                            {job.sourceFileName
                              ? `${job.sourceFileName}${job.mediaDurationSec ? ` · ${formatTime(job.mediaDurationSec)}` : ""}`
                              : job.isLiveStream
                                ? "Live stream capture"
                                : "Awaiting media"}
                          </p>

                          {inFlight && (
                            <div className="space-y-1 pt-0.5">
                              <Progress value={job.progressPct} className="h-1" />
                              <p className="truncate text-[10px] text-muted-foreground">
                                {job.progressMessage ?? "Processing..."}
                              </p>
                            </div>
                          )}

                          <div className="flex items-center justify-between pt-1">
                            <div className="flex items-center gap-2.5 text-xs text-muted-foreground tabular-nums">
                              <span>{job._count?.candidates ?? 0} clips</span>
                              <span>·</span>
                              <span>{job._count?.renderExports ?? 0} exports</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Link href={`/jobs/${job.id}`}>
                                <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs">
                                  Open Studio
                                </Button>
                              </Link>
                              <Button
                                size="icon"
                                variant="ghost"
                                title="Delete job"
                                onClick={() => handleDeleteJob(job.id)}
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
