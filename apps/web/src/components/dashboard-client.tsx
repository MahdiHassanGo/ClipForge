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

  const [creating, setCreating] = useState(false);
  const [jobs, setJobs] = useState<ClipJobSummaryDto[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);

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
        <Card className="border-primary/25 bg-gradient-to-b from-card to-card/70">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Link2 className="h-5 w-5 text-primary" />
                  New Gaming Clip Project
                </CardTitle>
                <CardDescription className="mt-1">
                  Step 1: Paste a YouTube video or stream URL to validate it and load permitted metadata.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowSettings((v) => !v)}
              >
                <Settings2 className="h-4 w-4" />
                Clip Settings
              </Button>
            </div>
          </CardHeader>

          <CardContent className="space-y-5">
            <form onSubmit={handleInspect} className="flex flex-col gap-3 sm:flex-row">
              <Input
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=... or https://youtu.be/... or /live/..."
                className="flex-1"
                required
              />
              <Button type="submit" disabled={inspecting} className="sm:w-44">
                {inspecting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Inspecting...
                  </>
                ) : (
                  <>
                    Inspect URL
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </form>

            {showSettings && (
              <div className="grid gap-4 rounded-lg border border-border bg-secondary/30 p-4 sm:grid-cols-2 lg:grid-cols-5">
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Min Clip (sec)</span>
                  <Input
                    type="number"
                    min={5}
                    max={120}
                    value={minClipSec}
                    onChange={(e) => setMinClipSec(Number(e.target.value))}
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Target Clip (sec)</span>
                  <Input
                    type="number"
                    min={10}
                    max={120}
                    value={targetClipSec}
                    onChange={(e) => setTargetClipSec(Number(e.target.value))}
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Max Clip (sec)</span>
                  <Input
                    type="number"
                    min={10}
                    max={180}
                    value={maxClipSec}
                    onChange={(e) => setMaxClipSec(Number(e.target.value))}
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Score Threshold (0.1–0.95)</span>
                  <Input
                    type="number"
                    step={0.05}
                    min={0.1}
                    max={0.95}
                    value={scoreThreshold}
                    onChange={(e) => setScoreThreshold(Number(e.target.value))}
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Caption Language</span>
                  <select
                    value={captionLanguage}
                    onChange={(e) => setCaptionLanguage(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background/80 px-3 text-sm"
                  >
                    {SUPPORTED_CAPTION_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {inspectError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{inspectError}</span>
              </div>
            )}

            {inspected && (
              <div className="rounded-xl border border-border bg-secondary/25 p-5">
                <div className="flex flex-col gap-5 md:flex-row">
                  {inspected.metadata.thumbnailUrl && (
                    <img
                      src={inspected.metadata.thumbnailUrl}
                      alt={inspected.metadata.title ?? "YouTube video thumbnail"}
                      className="h-32 w-full rounded-lg border border-border object-cover md:w-56"
                    />
                  )}
                  <div className="flex-1 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="success">
                        <CheckCircle2 className="h-3 w-3" />
                        Valid Video ID: {inspected.metadata.videoId}
                      </Badge>
                      <Badge variant={streamTypeLabel(inspected.metadata.streamType).variant}>
                        <Radio className="h-3 w-3" />
                        {streamTypeLabel(inspected.metadata.streamType).label}
                      </Badge>
                      {inspected.metadata.durationSec && (
                        <Badge variant="secondary">
                          <Clock className="h-3 w-3" />
                          {formatTime(inspected.metadata.durationSec)}
                        </Badge>
                      )}
                      <Badge variant="secondary">
                        Source: {inspected.metadata.metadataSource}
                      </Badge>
                    </div>

                    <div>
                      <h3 className="text-base font-semibold">
                        {inspected.metadata.title ?? `YouTube Video (${inspected.metadata.videoId})`}
                      </h3>
                      {inspected.metadata.channelTitle && (
                        <p className="text-xs text-muted-foreground">
                          Channel: {inspected.metadata.channelTitle}
                        </p>
                      )}
                    </div>

                    {inspected.isLiveStream || inspected.metadata.streamType === "live_stream" ? (
                      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs leading-relaxed text-amber-100">
                        <p className="font-semibold text-amber-300">
                          🔴 Live Stream Detected — Real-time Ingestion Enabled
                        </p>
                        <p className="mt-1 text-amber-200/90">
                          {inspected.ingestion.reason}
                        </p>
                        <p className="mt-1 text-amber-200/75">
                          ClipForge uses rolling HLS audio pulls (~1MB/min) + live chat velocity spikes (MPS) to pinpoint clutch moments, then selectively fetches only the 30–60s peak video slice.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-primary/25 bg-primary/10 p-3 text-xs leading-relaxed text-sky-100">
                        <p className="font-medium text-primary">
                          Authorized Source File Required ({inspected.ingestion.providerName})
                        </p>
                        <p className="mt-1 text-muted-foreground">
                          {inspected.metadata.mediaAccessReason}
                        </p>
                        <p className="mt-1 text-muted-foreground/90">
                          {inspected.metadata.notice}
                        </p>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      {inspected.isLiveStream || inspected.metadata.streamType === "live_stream" ? (
                        <>
                          <Button
                            onClick={() => handleCreateProject(true)}
                            disabled={creating}
                            className="bg-amber-500 font-semibold text-black hover:bg-amber-400"
                          >
                            {creating ? (
                              <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Starting Live Monitor...
                              </>
                            ) : (
                              <>
                                <Radio className="h-4 w-4" />
                                Monitor Live Stream (No Upload Needed)
                                <ArrowRight className="h-4 w-4" />
                              </>
                            )}
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => handleCreateProject(false)}
                            disabled={creating}
                          >
                            Upload Local VOD/Recording Instead
                          </Button>
                        </>
                      ) : (
                        <Button onClick={() => handleCreateProject(false)} disabled={creating}>
                          {creating ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Creating Project...
                            </>
                          ) : (
                            <>
                              Continue to Authorized Video Upload
                              <ArrowRight className="h-4 w-4" />
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
                        Open Stream / URL
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
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Your Clip Jobs</h2>
              <p className="text-xs text-muted-foreground">
                Background analysis and 9:16 renders persist in PostgreSQL — safely leave and return anytime.
              </p>
            </div>
            <Badge variant="secondary">{jobs.length} total</Badge>
          </div>

          {loadingJobs && jobs.length === 0 ? (
            <Card>
              <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading your clip jobs...
              </CardContent>
            </Card>
          ) : jobs.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Film className="mb-3 h-10 w-10 text-muted-foreground/60" />
                <p className="text-sm font-medium">No clip jobs yet</p>
                <p className="mt-1 max-w-md text-xs text-muted-foreground">
                  Paste a YouTube URL above to inspect its metadata, then upload your authorized
                  gaming recording to generate vertical clips.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
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
                    className="group transition hover:border-primary/40"
                  >
                    <CardContent className="p-4">
                      <div className="flex gap-4">
                        {job.youtubeThumbnailUrl ? (
                          <img
                            src={job.youtubeThumbnailUrl}
                            alt={job.youtubeTitle ?? job.youtubeVideoId}
                            className="h-20 w-32 shrink-0 rounded-lg border border-border object-cover"
                          />
                        ) : (
                          <div className="flex h-20 w-32 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
                            <Video className="h-6 w-6 text-muted-foreground" />
                          </div>
                        )}

                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                            <Badge variant={stream.variant}>{stream.label}</Badge>
                            {job.isLiveStream && (
                              <Badge variant="accent">🔴 Live HLS</Badge>
                            )}
                          </div>

                          <Link
                            href={`/jobs/${job.id}`}
                            className="block truncate text-sm font-semibold hover:text-primary"
                          >
                            {job.youtubeTitle ?? `YouTube Video (${job.youtubeVideoId})`}
                          </Link>

                          <p className="truncate text-xs text-muted-foreground">
                            {job.sourceFileName
                              ? `File: ${job.sourceFileName}${job.mediaDurationSec ? ` · ${formatTime(job.mediaDurationSec)}` : ""}`
                              : job.isLiveStream
                                ? "Live HLS Stream (Audio-First + Chat Velocity)"
                                : "No media uploaded yet"}
                          </p>

                          {inFlight && (
                            <div className="space-y-1">
                              <Progress value={job.progressPct} />
                              <p className="truncate text-[11px] text-muted-foreground">
                                {job.progressMessage ?? "Processing..."}
                              </p>
                            </div>
                          )}

                          {job.status === "failed" && job.errorMessage && (
                            <p className="line-clamp-1 text-xs text-red-400">
                              {job.errorMessage}
                            </p>
                          )}

                          <div className="flex items-center justify-between pt-1">
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              <span>{job._count?.candidates ?? 0} clips</span>
                              <span>{job._count?.renderExports ?? 0} exports</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Link href={`/jobs/${job.id}`}>
                                <Button size="sm" variant="secondary">
                                  Open Studio
                                </Button>
                              </Link>
                              <Button
                                size="icon"
                                variant="ghost"
                                title="Delete job and stored media"
                                onClick={() => handleDeleteJob(job.id)}
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
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
