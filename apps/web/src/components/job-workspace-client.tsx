"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  CheckCircle2,
  Download,
  Film,
  Layers,
  Loader2,
  Play,
  Pause,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Scissors,
  Sparkles,
  Subtitles,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  EXPORT_PRESETS,
  SUPPORTED_CAPTION_LANGUAGES,
  type CaptionCue,
  type CaptionStyle,
  type ExportPreset,
  type FaceCamRegion,
  type JobStatus,
  type LayoutMode,
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
import { UploadZone } from "@/components/upload-zone";
import type {
  CandidateClipDto,
  CapabilitiesDto,
  ClipJobDetailDto,
  RenderExportDto,
  UserDto,
} from "@/components/types";
import { formatBytes, formatTime, formatTimePrecise } from "@/lib/utils";

const PIPELINE_STEPS: ReadonlyArray<{ key: JobStatus; label: string }> = [
  { key: "queued", label: "Link Queued" },
  { key: "uploading", label: "Media Ingest" },
  { key: "analyzing", label: "Multimodal Analysis" },
  { key: "candidates_ready", label: "Review & Edit" },
  { key: "rendering", label: "9:16 Render" },
  { key: "complete", label: "MP4 Ready" },
];

const CORNER_PRESETS: Record<
  "top_left" | "top_right" | "bottom_left" | "bottom_right",
  Omit<FaceCamRegion, "confidence" | "enabled">
> = {
  top_left: { corner: "top_left", x: 0.02, y: 0.03, width: 0.23, height: 0.24 },
  top_right: { corner: "top_right", x: 0.75, y: 0.03, width: 0.23, height: 0.24 },
  bottom_left: { corner: "bottom_left", x: 0.02, y: 0.72, width: 0.23, height: 0.24 },
  bottom_right: { corner: "bottom_right", x: 0.75, y: 0.72, width: 0.23, height: 0.24 },
};

function getStepIndex(status: JobStatus): number {
  if (status === "live_monitoring") return 2;
  const idx = PIPELINE_STEPS.findIndex((s) => s.key === status);
  return idx >= 0 ? idx : 0;
}

export function JobWorkspaceClient({
  user,
  capabilities,
  initialJob,
}: {
  user: UserDto;
  capabilities: CapabilitiesDto;
  initialJob: ClipJobDetailDto;
}) {
  const [job, setJob] = useState<ClipJobDetailDto>(initialJob);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(
    initialJob.candidates[0]?.id ?? null,
  );
  const [activeTab, setActiveTab] = useState<"layout" | "captions" | "export">("layout");

  // Local editable draft state for the currently selected clip
  const [draftTitle, setDraftTitle] = useState("");
  const [draftStart, setDraftStart] = useState(0);
  const [draftEnd, setDraftEnd] = useState(30);
  const [draftLayout, setDraftLayout] = useState<LayoutMode>("gameplay_focus");
  const [draftFaceCam, setDraftFaceCam] = useState<FaceCamRegion | null>(null);
  const [draftCaptionsEnabled, setDraftCaptionsEnabled] = useState(true);
  const [draftCaptionLang, setDraftCaptionLang] = useState("en");
  const [draftCaptionStyle, setDraftCaptionStyle] = useState<CaptionStyle>("bold_gaming");
  const [draftCaptions, setDraftCaptions] = useState<CaptionCue[]>([]);
  const [isDirty, setIsDirty] = useState(false);

  const [savingClip, setSavingClip] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryingJob, setRetryingJob] = useState(false);

  // Export panel state
  const [selectedPresets, setSelectedPresets] = useState<ExportPreset[]>([
    "youtube_shorts",
  ]);
  const [rendering, setRendering] = useState(false);
  const [previewExportId, setPreviewExportId] = useState<string | null>(null);

  // Video player state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const selectedClip = useMemo(
    () => job.candidates.find((c) => c.id === selectedClipId) ?? null,
    [job.candidates, selectedClipId],
  );

  // Sync draft editor state whenever selectedClip changes (and user isn't mid-edit on same clip)
  useEffect(() => {
    if (!selectedClip) return;
    setDraftTitle(selectedClip.title);
    setDraftStart(selectedClip.startSec);
    setDraftEnd(selectedClip.endSec);
    setDraftLayout(selectedClip.layoutMode);
    setDraftFaceCam(selectedClip.faceCamCropJson);
    setDraftCaptionsEnabled(selectedClip.captionsEnabled);
    setDraftCaptionLang(selectedClip.captionLanguage);
    setDraftCaptionStyle(selectedClip.captionStyle);
    setDraftCaptions(Array.isArray(selectedClip.captionsJson) ? selectedClip.captionsJson : []);
    setIsDirty(false);
    setSaveMessage(null);
    setActionError(null);

    if (videoRef.current) {
      videoRef.current.currentTime = selectedClip.startSec;
      setCurrentTime(selectedClip.startSec);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClip?.id]);

  // Select first candidate automatically when analysis finishes
  useEffect(() => {
    if (!selectedClipId && job.candidates.length > 0) {
      setSelectedClipId(job.candidates[0]!.id);
    }
  }, [job.candidates, selectedClipId]);

  const refreshJob = useCallback(async () => {
    const res = await fetch(`/api/jobs/${job.id}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.job) {
      setJob(data.job);
    }
  }, [job.id]);

  // Auto-poll while job or any render export is active
  const hasActiveWork =
    job.status === "uploading" ||
    job.status === "analyzing" ||
    job.status === "live_monitoring" ||
    job.status === "rendering" ||
    job.renderExports.some((e) => e.status === "queued" || e.status === "rendering");

  useEffect(() => {
    if (!hasActiveWork) return;
    const interval = setInterval(() => {
      void refreshJob();
    }, 2000);
    return () => clearInterval(interval);
  }, [hasActiveWork, refreshJob]);

  // Keep preview playback looped within [draftStart, draftEnd]
  function handleVideoTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    if (selectedClip && !v.paused && v.currentTime >= draftEnd) {
      v.pause();
      v.currentTime = draftStart;
      setIsPlaying(false);
    }
  }

  function togglePlayClip() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < draftStart || v.currentTime >= draftEnd - 0.1) {
        v.currentTime = draftStart;
      }
      void v.play();
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
  }

  function seekTo(sec: number) {
    const clamped = Math.max(0, Math.min(job.mediaDurationSec ?? 9999, sec));
    if (videoRef.current) {
      videoRef.current.currentTime = clamped;
    }
    setCurrentTime(clamped);
  }

  async function saveClipChanges(override?: Partial<{
    status: CandidateClipDto["status"];
  }>) {
    if (!selectedClip) return;
    setSavingClip(true);
    setActionError(null);
    setSaveMessage(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/candidates/${selectedClip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draftTitle,
          startSec: Number(draftStart),
          endSec: Number(draftEnd),
          status: override?.status ?? selectedClip.status,
          layoutMode: draftLayout,
          faceCamCrop: draftFaceCam,
          captionLanguage: draftCaptionLang,
          captionStyle: draftCaptionStyle,
          captionsEnabled: draftCaptionsEnabled,
          captions: draftCaptions,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error ?? "Failed to save clip changes.");
        return;
      }
      setJob((prev) => ({
        ...prev,
        candidates: prev.candidates.map((c) =>
          c.id === selectedClip.id ? data.candidate : c,
        ),
      }));
      setIsDirty(false);
      setSaveMessage("Saved");
      setTimeout(() => setSaveMessage(null), 2000);
    } catch {
      setActionError("Network error while saving clip changes.");
    } finally {
      setSavingClip(false);
    }
  }

  async function quickSetClipStatus(
    clip: CandidateClipDto,
    status: CandidateClipDto["status"],
  ) {
    setActionError(null);
    const res = await fetch(`/api/jobs/${job.id}/candidates/${clip.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const data = await res.json();
    if (!res.ok) {
      setActionError(data.error ?? "Could not update clip status.");
      return;
    }
    setJob((prev) => ({
      ...prev,
      candidates: prev.candidates.map((c) => (c.id === clip.id ? data.candidate : c)),
    }));
  }

  async function handleRetryJob() {
    setRetryingJob(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/retry`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error ?? "Retry failed.");
        return;
      }
      await refreshJob();
    } catch {
      setActionError("Network error while retrying job.");
    } finally {
      setRetryingJob(false);
    }
  }

  function togglePreset(preset: ExportPreset) {
    setSelectedPresets((prev) =>
      prev.includes(preset)
        ? prev.length > 1
          ? prev.filter((p) => p !== preset)
          : prev
        : [...prev, preset],
    );
  }

  async function handleRender(clipIds: string[]) {
    if (clipIds.length === 0) {
      setActionError("Select at least one clip to render.");
      return;
    }
    if (isDirty && selectedClip && clipIds.includes(selectedClip.id)) {
      await saveClipChanges();
    }

    setRendering(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clipIds,
          presets: selectedPresets,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error ?? "Failed to queue render.");
        return;
      }
      setActiveTab("export");
      await refreshJob();
    } catch {
      setActionError("Network error while queueing render.");
    } finally {
      setRendering(false);
    }
  }

  async function handleRetryExport(exportId: string) {
    setActionError(null);
    const res = await fetch(`/api/exports/${exportId}/retry`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setActionError(data.error ?? "Could not retry export.");
      return;
    }
    await refreshJob();
  }

  function updateCaptionCue(idx: number, patch: Partial<CaptionCue>) {
    setDraftCaptions((prev) =>
      prev.map((cue, i) => (i === idx ? { ...cue, ...patch } : cue)),
    );
    setIsDirty(true);
  }

  function addCaptionCue() {
    const start = Math.max(draftStart, Math.min(draftEnd - 1.5, currentTime || draftStart));
    const end = Math.min(draftEnd, start + 2.5);
    setDraftCaptions((prev) => [
      ...prev,
      {
        id: `manual_${Date.now()}`,
        startSec: Math.round(start * 100) / 100,
        endSec: Math.round(end * 100) / 100,
        text: "New caption text",
        confidence: 1,
        needsReview: false,
      },
    ]);
    setIsDirty(true);
  }

  function removeCaptionCue(idx: number) {
    setDraftCaptions((prev) => prev.filter((_, i) => i !== idx));
    setIsDirty(true);
  }

  const activeCaptionForPreview = useMemo(() => {
    if (!draftCaptionsEnabled) return null;
    return (
      draftCaptions.find(
        (c) =>
          currentTime >= c.startSec &&
          currentTime <= c.endSec &&
          c.text.trim().length > 0,
      ) ?? null
    );
  }, [draftCaptions, draftCaptionsEnabled, currentTime]);

  const selectedCandidates = job.candidates.filter((c) => c.status === "selected");
  const unreviewedCount = draftCaptions.filter((c) => c.needsReview).length;
  const currentStepIdx = getStepIndex(job.status);

  const needsUpload =
    job.sourceProvider === "authorized_upload" &&
    !job.isLiveStream &&
    (job.status === "queued" || (job.status === "failed" && !job.sourceStorageKey));

  return (
    <div className="min-h-screen pb-16">
      <Navbar user={user} capabilities={capabilities} />

      <main className="mx-auto max-w-7xl space-y-6 px-4 pt-6 sm:px-6">
        {/* Top Breadcrumb + Job Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Projects
            </Link>
            <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              <span>{job.youtubeTitle ?? `YouTube Video (${job.youtubeVideoId})`}</span>
              {job.isLiveStream && (
                <span className="inline-flex items-center gap-1.5 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-xs font-medium text-rose-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                  Live Ingest
                </span>
              )}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground tabular-nums">
              {job.youtubeChannel && <span>{job.youtubeChannel}</span>}
              <span>·</span>
              <span>ID: {job.youtubeVideoId}</span>
              {job.sourceFileName && (
                <>
                  <span>·</span>
                  <span className="text-foreground">{job.sourceFileName}</span>
                </>
              )}
              {job.mediaWidth && job.mediaHeight && (
                <>
                  <span>·</span>
                  <span>
                    {job.mediaWidth}×{job.mediaHeight} @ {job.mediaFps ?? 30}fps
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(job.status === "failed" || job.status === "cancelled") && (
              <Button onClick={handleRetryJob} disabled={retryingJob} size="sm">
                <RotateCcw className="h-3.5 w-3.5" />
                {retryingJob ? "Retrying..." : "Retry Job"}
              </Button>
            )}
            {job.status === "candidates_ready" && job.sourceStorageKey && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRetryJob}
                disabled={retryingJob}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Re-Analyze
              </Button>
            )}
          </div>
        </div>

        {/* Typed State Machine Stepper */}
        <Card className="border-border/80 bg-card">
          <CardContent className="p-3.5">
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-6">
              {PIPELINE_STEPS.map((step, idx) => {
                const isDone =
                  job.status !== "failed" &&
                  job.status !== "cancelled" &&
                  idx < currentStepIdx;
                const isCurrent = step.key === job.status;
                return (
                  <div
                    key={step.key}
                    className={`flex items-center gap-2 rounded border px-2.5 py-1.5 text-xs transition-colors ${
                      isCurrent
                        ? "border-primary/80 bg-primary/10 text-primary font-medium"
                        : isDone
                          ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-400"
                          : "border-border/60 bg-secondary/20 text-muted-foreground"
                    }`}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] tabular-nums font-mono">
                      {isDone ? "✓" : idx + 1}
                    </span>
                    <span className="truncate">{step.label}</span>
                  </div>
                );
              })}
            </div>

            {(job.status === "uploading" || job.status === "analyzing" || job.status === "live_monitoring" || job.status === "queued") && (
              <div className="mt-3 space-y-1.5 rounded border border-primary/20 bg-primary/5 p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2 font-medium text-primary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {job.progressMessage ?? (job.status === "live_monitoring" ? "Monitoring stream live..." : "Processing media...")}
                  </span>
                  <span className="font-mono text-muted-foreground tabular-nums">{job.progressPct}%</span>
                </div>
                <Progress value={job.progressPct} className="h-1" />
              </div>
            )}

            {job.isLiveStream && job.status === "live_monitoring" && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded border border-border/80 bg-secondary/30 px-3.5 py-2 text-xs">
                <div className="flex items-center gap-2 text-foreground font-medium">
                  <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
                  Live HLS Stream Telemetry
                </div>
                <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground tabular-nums">
                  <span><span className="text-foreground">Manifest:</span> Rolling .m3u8</span>
                  <span><span className="text-foreground">Audio:</span> ~1MB/min Stream</span>
                  <span><span className="text-foreground">Chat:</span> Spike Detector (MPS)</span>
                  <span><span className="text-foreground">Slice:</span> 30–60s Peak Ingest</span>
                </div>
              </div>
            )}

            {job.status === "failed" && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3.5 text-xs text-red-200">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  <div>
                    <p className="font-semibold text-red-100">
                      Job failed ({job.errorCode ?? "ERROR"})
                    </p>
                    <p className="mt-0.5 text-red-200/90">
                      {job.errorMessage ?? "An error interrupted processing."}
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="destructive" onClick={handleRetryJob} disabled={retryingJob}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              </div>
            )}

            {job.analysisSummary && job.status !== "analyzing" && (
              <p className="mt-3 text-xs text-muted-foreground">{job.analysisSummary}</p>
            )}
          </CardContent>
        </Card>

        {actionError && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{actionError}</span>
          </div>
        )}

        {/* Phase A: Optional Manual Upload View (only when explicitly requested) */}
        {needsUpload && (
          <Card>
            <CardHeader>
              <CardTitle>Upload Source Video</CardTitle>
              <CardDescription>
                Upload your recording or VOD file below so our worker can analyze audio reactions,
                speech, scene cuts, gameplay motion, and face-cam framing.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <UploadZone
                jobId={job.id}
                maxUploadBytes={capabilities.maxUploadBytes}
                onUploadComplete={() => {
                  void refreshJob();
                }}
              />
            </CardContent>
          </Card>
        )}

        {/* Phase A.2: Direct Scraping & Analysis Waiting Card */}
        {!needsUpload && job.candidates.length === 0 && job.status !== "failed" && (
          <Card className="border-border/80 bg-card p-8 text-center">
            <div className="mx-auto flex max-w-md flex-col items-center justify-center space-y-3">
              <div className="rounded-full bg-primary/10 p-3 text-primary">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
              <h3 className="text-base font-medium text-foreground">
                {job.progressMessage || "Scraping & analyzing media..."}
              </h3>
              <p className="text-xs text-muted-foreground">
                ClipForge is scraping the media directly from the URL, transcribing word timestamps, and analyzing highlights. Detected clip candidates will appear here automatically.
              </p>
            </div>
          </Card>
        )}

        {/* Phase B: Review, Edit, Caption & 9:16 Export Studio */}
        {!needsUpload && job.candidates.length > 0 && (
          <div className="grid gap-6 lg:grid-cols-12">
            {/* LEFT COLUMN: Candidate Clips List */}
            <div className="space-y-3 lg:col-span-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Detected Moments ({job.candidates.length})
                </h2>
                <Badge variant="default">
                  {selectedCandidates.length} selected for export
                </Badge>
              </div>

              <div className="space-y-3">
                {job.candidates.map((clip) => {
                  const isCurrent = clip.id === selectedClipId;
                  const dur = Math.max(0, clip.endSec - clip.startSec);
                  return (
                    <div
                      key={clip.id}
                      onClick={() => setSelectedClipId(clip.id)}
                      className={`cursor-pointer rounded-md border p-3 transition-colors ${
                        isCurrent
                          ? "border-primary/80 bg-secondary/50"
                          : clip.status === "discarded"
                            ? "border-border/40 bg-card/40 opacity-50 hover:opacity-75"
                            : "border-border/80 bg-card hover:border-border"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="secondary" className="text-[10px] py-0 font-mono tabular-nums">#{clip.rank}</Badge>
                            <Badge
                              variant={
                                clip.score >= 0.7
                                  ? "success"
                                  : clip.score >= 0.5
                                    ? "default"
                                    : "secondary"
                              }
                              className="text-[10px] py-0 font-mono tabular-nums"
                            >
                              Score {Math.round(clip.score * 100)}
                            </Badge>
                            <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                              {formatTime(clip.startSec)}–{formatTime(clip.endSec)} ({Math.round(dur)}s)
                            </span>
                          </div>
                          <h3 className="mt-1.5 truncate text-xs font-medium text-foreground">
                            {clip.title}
                          </h3>
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          {clip.status === "selected" ? (
                            <Button
                              size="sm"
                              variant="default"
                              className="h-6 px-2 text-[10px]"
                              onClick={(e) => {
                                e.stopPropagation();
                                void quickSetClipStatus(clip, "suggested");
                              }}
                            >
                              <Check className="h-3 w-3" />
                              Selected
                            </Button>
                          ) : clip.status === "discarded" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[10px]"
                              onClick={(e) => {
                                e.stopPropagation();
                                void quickSetClipStatus(clip, "suggested");
                              }}
                            >
                              Restore
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[10px]"
                              onClick={(e) => {
                                e.stopPropagation();
                                void quickSetClipStatus(clip, "selected");
                              }}
                            >
                              Select
                            </Button>
                          )}

                          {clip.status !== "discarded" && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Discard candidate"
                              className="h-6 w-6 text-muted-foreground hover:text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                void quickSetClipStatus(clip, "discarded");
                              }}
                            >
                              <XCircle className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </div>

                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground line-clamp-2">
                        {clip.reason}
                      </p>

                      {clip.signalBreakdown && (
                        <div className={`mt-2 grid gap-1.5 text-[10px] text-muted-foreground tabular-nums ${
                          clip.signalBreakdown.chatVelocityScore !== undefined ? "grid-cols-5" : "grid-cols-4"
                        }`}>
                          <SignalMiniBar label="Speech" value={clip.signalBreakdown.speechScore} />
                          <SignalMiniBar label="Reaction" value={clip.signalBreakdown.reactionScore} />
                          <SignalMiniBar label="Motion" value={clip.signalBreakdown.motionScore} />
                          <SignalMiniBar label="Scene" value={clip.signalBreakdown.sceneScore} />
                          {clip.signalBreakdown.chatVelocityScore !== undefined && (
                            <SignalMiniBar label="Chat Hype" value={clip.signalBreakdown.chatVelocityScore} />
                          )}
                        </div>
                      )}

                      {clip.hasUnreviewedCaptions && (
                        <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-amber-300/90">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                          Captions need review
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* RIGHT 8 COLUMNS: Playable Preview + Editor Tabs */}
            <div className="space-y-5 lg:col-span-8">
              {selectedClip && (
                <>
                  {/* Playable Video Preview + Timeline Trimmer */}
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-1 items-center gap-2">
                          <Scissors className="h-4 w-4 text-primary" />
                          <Input
                            value={draftTitle}
                            onChange={(e) => {
                              setDraftTitle(e.target.value);
                              setIsDirty(true);
                            }}
                            className="h-9 max-w-md font-semibold"
                            aria-label="Clip title"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          {saveMessage && (
                            <span className="text-xs text-emerald-400">{saveMessage}</span>
                          )}
                          <Button
                            size="sm"
                            variant={isDirty ? "default" : "secondary"}
                            disabled={savingClip || !isDirty}
                            onClick={() => void saveClipChanges()}
                          >
                            <Save className="h-3.5 w-3.5" />
                            {savingClip ? "Saving..." : "Save Edits"}
                          </Button>
                        </div>
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-4">
                      {/* Source Video Player with Live Caption Overlay & Face-Cam Overlay Box */}
                      <div className="relative overflow-hidden rounded-xl border border-border bg-black">
                        <video
                          ref={videoRef}
                          src={`/api/jobs/${job.id}/media`}
                          className="aspect-video w-full object-contain"
                          controls
                          onTimeUpdate={handleVideoTimeUpdate}
                          onPlay={() => setIsPlaying(true)}
                          onPause={() => setIsPlaying(false)}
                        />

                        {/* Face-Cam Source Box Indicator */}
                        {draftFaceCam && draftFaceCam.enabled !== false && draftLayout !== "gameplay_focus" && (
                          <div
                            className="pointer-events-none absolute border-2 border-primary bg-primary/15"
                            style={{
                              left: `${draftFaceCam.x * 100}%`,
                              top: `${draftFaceCam.y * 100}%`,
                              width: `${draftFaceCam.width * 100}%`,
                              height: `${draftFaceCam.height * 100}%`,
                            }}
                          >
                            <span className="bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                              Face-Cam Crop
                            </span>
                          </div>
                        )}

                        {/* Synced Live Caption Overlay Preview */}
                        {activeCaptionForPreview &&
                          !activeCaptionForPreview.text.startsWith("[Speech activity detected") && (
                            <div className="pointer-events-none absolute inset-x-6 bottom-12 flex justify-center">
                              <span
                                className={`max-w-[85%] rounded px-3 py-1 text-center ${
                                  draftCaptionStyle === "bold_gaming"
                                    ? "text-base font-extrabold uppercase tracking-wide text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.95)]"
                                    : draftCaptionStyle === "boxed_high_contrast"
                                      ? "bg-black/85 text-sm font-bold text-white"
                                      : "text-sm font-medium text-slate-100 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]"
                                }`}
                              >
                                {activeCaptionForPreview.text}
                              </span>
                            </div>
                          )}
                      </div>

                      {/* Playback + Boundary Controls */}
                      <div className="space-y-3 rounded-lg border border-border bg-secondary/25 p-3.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Button size="sm" onClick={togglePlayClip}>
                              {isPlaying ? (
                                <>
                                  <Pause className="h-3.5 w-3.5" />
                                  Pause Clip
                                </>
                              ) : (
                                <>
                                  <Play className="h-3.5 w-3.5" />
                                  Preview Clip ({Math.round(draftEnd - draftStart)}s)
                                </>
                              )}
                            </Button>
                            <span className="font-mono text-xs text-muted-foreground">
                              Playhead: {formatTimePrecise(currentTime)} /{" "}
                              {formatTimePrecise(job.mediaDurationSec ?? 0)}
                            </span>
                          </div>

                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const next = Math.min(currentTime, draftEnd - 3);
                                setDraftStart(Math.max(0, Math.round(next * 10) / 10));
                                setIsDirty(true);
                              }}
                            >
                              Set Start = Playhead
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const next = Math.max(currentTime, draftStart + 3);
                                setDraftEnd(
                                  Math.min(
                                    job.mediaDurationSec ?? next,
                                    Math.round(next * 10) / 10,
                                  ),
                                );
                                setIsDirty(true);
                              }}
                            >
                              Set End = Playhead
                            </Button>
                          </div>
                        </div>

                        {/* Timeline Bar with Detected Scene / Audio / Motion Markers */}
                        {job.mediaDurationSec && job.mediaDurationSec > 0 && (
                          <div className="space-y-1">
                            <div className="relative h-6 w-full overflow-hidden rounded bg-background/90">
                              {/* Selected clip highlight */}
                              <div
                                className="absolute inset-y-0 bg-primary/25 border-x-2 border-primary"
                                style={{
                                  left: `${(draftStart / job.mediaDurationSec) * 100}%`,
                                  width: `${Math.max(1, ((draftEnd - draftStart) / job.mediaDurationSec) * 100)}%`,
                                }}
                              />
                              {/* Scene/Audio/Motion event ticks */}
                              {job.sceneEvents.slice(0, 120).map((ev) => (
                                <button
                                  key={ev.id}
                                  type="button"
                                  title={`${ev.type.replace("_", " ")} at ${formatTime(ev.timestampSec)}`}
                                  onClick={() => seekTo(ev.timestampSec)}
                                  className={`absolute bottom-0 w-1 hover:opacity-100 ${
                                    ev.type === "audio_reaction" || ev.type === "silence_to_burst"
                                      ? "bg-amber-400/80"
                                      : ev.type === "scene_cut"
                                        ? "bg-violet-400/80"
                                        : "bg-emerald-400/70"
                                  }`}
                                  style={{
                                    left: `${Math.min(99.5, (ev.timestampSec / job.mediaDurationSec!) * 100)}%`,
                                    height: `${Math.max(30, Math.round(ev.score * 100))}%`,
                                  }}
                                />
                              ))}
                              {/* Playhead indicator */}
                              <div
                                className="pointer-events-none absolute inset-y-0 w-0.5 bg-white"
                                style={{
                                  left: `${Math.min(100, (currentTime / job.mediaDurationSec) * 100)}%`,
                                }}
                              />
                            </div>
                            <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <span className="h-2 w-2 rounded-full bg-amber-400" />
                                Audio Reaction
                              </span>
                              <span className="flex items-center gap-1">
                                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                                Gameplay Motion
                              </span>
                              <span className="flex items-center gap-1">
                                <span className="h-2 w-2 rounded-full bg-violet-400" />
                                Scene Cut
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Start / End Numeric Inputs */}
                        <div className="grid gap-3 sm:grid-cols-3">
                          <label className="space-y-1 text-xs">
                            <span className="text-muted-foreground">Start Time (sec)</span>
                            <Input
                              type="number"
                              step={0.5}
                              min={0}
                              max={Math.max(0, draftEnd - 3)}
                              value={draftStart}
                              onChange={(e) => {
                                setDraftStart(Number(e.target.value));
                                setIsDirty(true);
                              }}
                            />
                          </label>
                          <label className="space-y-1 text-xs">
                            <span className="text-muted-foreground">End Time (sec)</span>
                            <Input
                              type="number"
                              step={0.5}
                              min={draftStart + 3}
                              max={job.mediaDurationSec ?? 9999}
                              value={draftEnd}
                              onChange={(e) => {
                                setDraftEnd(Number(e.target.value));
                                setIsDirty(true);
                              }}
                            />
                          </label>
                          <div className="flex flex-col justify-end rounded-md border border-border bg-background/60 px-3 py-2 text-xs">
                            <span className="text-muted-foreground">Clip Length</span>
                            <span className="font-mono text-sm font-semibold">
                              {(draftEnd - draftStart).toFixed(1)}s
                              {draftEnd - draftStart > 60 && (
                                <span className="ml-1.5 text-[10px] font-normal text-amber-300">
                                  (&gt;60s Shorts max)
                                </span>
                              )}
                            </span>
                          </div>
                        </div>

                        <div className="rounded-md bg-background/50 p-2.5 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Transcript excerpt: </span>
                          {selectedClip.transcriptExcerpt}
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Configuration & Export Tabs */}
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant={activeTab === "layout" ? "default" : "secondary"}
                          onClick={() => setActiveTab("layout")}
                        >
                          <Layers className="h-3.5 w-3.5" />
                          9:16 Layout & Face-Cam
                        </Button>
                        <Button
                          size="sm"
                          variant={activeTab === "captions" ? "default" : "secondary"}
                          onClick={() => setActiveTab("captions")}
                        >
                          <Subtitles className="h-3.5 w-3.5" />
                          Captions ({draftCaptions.length})
                          {unreviewedCount > 0 && (
                            <span className="ml-1 rounded-full bg-amber-500/25 px-1.5 text-[10px] text-amber-200">
                              {unreviewedCount} review
                            </span>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant={activeTab === "export" ? "default" : "secondary"}
                          onClick={() => setActiveTab("export")}
                        >
                          <Film className="h-3.5 w-3.5" />
                          Export MP4 ({job.renderExports.length})
                        </Button>
                      </div>
                    </CardHeader>

                    <CardContent>
                      {/* TAB 1: 9:16 LAYOUT & FACE-CAM */}
                      {activeTab === "layout" && (
                        <div className="grid gap-6 md:grid-cols-12">
                          <div className="space-y-4 md:col-span-7">
                            <div className="space-y-2">
                              <p className="text-xs font-medium text-muted-foreground">
                                Vertical 9:16 Composition Mode
                              </p>
                              <div className="grid gap-2 sm:grid-cols-3">
                                {(
                                  [
                                    {
                                      id: "split_cam_top",
                                      title: "Split Cam Top",
                                      desc: "Face-cam top 30%, full-width gameplay below",
                                    },
                                    {
                                      id: "pip_overlay",
                                      title: "Face-Cam PiP",
                                      desc: "Gameplay main area + framed cam overlay",
                                    },
                                    {
                                      id: "gameplay_focus",
                                      title: "Gameplay Focus",
                                      desc: "No face-cam, HUD-safe ambient framing",
                                    },
                                  ] as const
                                ).map((opt) => (
                                  <button
                                    key={opt.id}
                                    type="button"
                                    onClick={() => {
                                      setDraftLayout(opt.id);
                                      if (opt.id !== "gameplay_focus" && !draftFaceCam) {
                                        setDraftFaceCam({
                                          ...CORNER_PRESETS.bottom_left,
                                          confidence: 1,
                                          enabled: true,
                                        });
                                      }
                                      setIsDirty(true);
                                    }}
                                    className={`rounded-lg border p-3 text-left transition ${
                                      draftLayout === opt.id
                                        ? "border-primary bg-primary/15"
                                        : "border-border bg-secondary/20 hover:border-primary/40"
                                    }`}
                                  >
                                    <p className="text-xs font-semibold">{opt.title}</p>
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                      {opt.desc}
                                    </p>
                                  </button>
                                ))}
                              </div>
                            </div>

                            {draftLayout !== "gameplay_focus" && (
                              <div className="space-y-3 rounded-lg border border-border bg-secondary/25 p-3.5">
                                <div className="flex items-center justify-between">
                                  <p className="flex items-center gap-1.5 text-xs font-medium">
                                    <Camera className="h-3.5 w-3.5 text-primary" />
                                    Face-Cam Source Position
                                  </p>
                                  <Badge variant={job.faceCamDetected ? "success" : "secondary"}>
                                    {job.faceCamDetected ? "Auto-detected" : "Manual region"}
                                  </Badge>
                                </div>

                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                  {(Object.keys(CORNER_PRESETS) as Array<keyof typeof CORNER_PRESETS>).map(
                                    (corner) => (
                                      <Button
                                        key={corner}
                                        size="sm"
                                        type="button"
                                        variant={
                                          draftFaceCam?.corner === corner
                                            ? "default"
                                            : "outline"
                                        }
                                        onClick={() => {
                                          setDraftFaceCam({
                                            ...CORNER_PRESETS[corner],
                                            confidence: draftFaceCam?.confidence ?? 1,
                                            enabled: true,
                                          });
                                          setIsDirty(true);
                                        }}
                                      >
                                        {corner.replace("_", " ")}
                                      </Button>
                                    ),
                                  )}
                                </div>

                                {draftFaceCam && (
                                  <div className="grid grid-cols-4 gap-2 text-xs">
                                    {(
                                      [
                                        ["x", "X %"],
                                        ["y", "Y %"],
                                        ["width", "W %"],
                                        ["height", "H %"],
                                      ] as const
                                    ).map(([field, label]) => (
                                      <label key={field} className="space-y-1">
                                        <span className="text-muted-foreground">{label}</span>
                                        <Input
                                          type="number"
                                          min={0}
                                          max={95}
                                          value={Math.round(draftFaceCam[field] * 100)}
                                          onChange={(e) => {
                                            const pct = Math.max(
                                              0,
                                              Math.min(95, Number(e.target.value)),
                                            );
                                            setDraftFaceCam({
                                              ...draftFaceCam,
                                              corner: "custom",
                                              [field]: pct / 100,
                                            });
                                            setIsDirty(true);
                                          }}
                                        />
                                      </label>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          {/* 9:16 Safe-Zone Wireframe Preview */}
                          <div className="flex flex-col items-center justify-center md:col-span-5">
                            <p className="mb-2 text-xs text-muted-foreground">
                              9:16 Framing & Platform Safe Zones
                            </p>
                            <div className="relative h-72 w-40 overflow-hidden rounded-2xl border-2 border-border bg-slate-950 shadow-inner">
                              {draftLayout === "split_cam_top" ? (
                                <>
                                  <div className="flex h-[30%] items-center justify-center border-b border-primary/40 bg-primary/20 text-[10px] font-medium text-primary">
                                    Face-Cam (30%)
                                  </div>
                                  <div className="flex h-[70%] items-center justify-center bg-slate-900 text-[10px] text-slate-300">
                                    Gameplay (HUD-safe)
                                  </div>
                                </>
                              ) : draftLayout === "pip_overlay" ? (
                                <div className="relative flex h-full items-center justify-center bg-slate-900 text-[10px] text-slate-300">
                                  Gameplay Main
                                  <div className="absolute left-2 top-7 rounded border border-primary bg-primary/25 px-2 py-3 text-[9px] font-medium text-primary">
                                    Face-Cam PiP
                                  </div>
                                </div>
                              ) : (
                                <div className="flex h-full items-center justify-center bg-slate-900 text-[10px] text-slate-300">
                                  Gameplay Focus
                                </div>
                              )}
                              {/* Caption safe zone */}
                              {draftCaptionsEnabled && (
                                <div className="absolute inset-x-3 bottom-12 rounded bg-black/75 py-1 text-center text-[9px] font-bold text-white">
                                  SYNCED CAPTIONS
                                </div>
                              )}
                              {/* Bottom platform UI danger zone */}
                              <div className="absolute inset-x-0 bottom-0 h-10 border-t border-dashed border-amber-400/50 bg-amber-500/10 text-center text-[8px] leading-10 text-amber-300">
                                Shorts/TikTok/Reels UI Zone
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* TAB 2: EDITABLE SYNCED CAPTIONS */}
                      {activeTab === "captions" && (
                        <div className="space-y-4">
                          <div className="grid gap-3 sm:grid-cols-4">
                            <label className="flex items-center gap-2 rounded-lg border border-border bg-secondary/25 px-3 py-2 text-xs">
                              <input
                                type="checkbox"
                                checked={draftCaptionsEnabled}
                                onChange={(e) => {
                                  setDraftCaptionsEnabled(e.target.checked);
                                  setIsDirty(true);
                                }}
                                className="h-4 w-4 accent-primary"
                              />
                              <span>Burn synced captions</span>
                            </label>

                            <label className="space-y-1 text-xs">
                              <span className="text-muted-foreground">Language</span>
                              <select
                                value={draftCaptionLang}
                                onChange={(e) => {
                                  setDraftCaptionLang(e.target.value);
                                  setIsDirty(true);
                                }}
                                className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                              >
                                {SUPPORTED_CAPTION_LANGUAGES.map((l) => (
                                  <option key={l.code} value={l.code}>
                                    {l.label}
                                  </option>
                                ))}
                              </select>
                            </label>

                            <label className="space-y-1 text-xs">
                              <span className="text-muted-foreground">Caption Style</span>
                              <select
                                value={draftCaptionStyle}
                                onChange={(e) => {
                                  setDraftCaptionStyle(e.target.value as CaptionStyle);
                                  setIsDirty(true);
                                }}
                                className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                              >
                                <option value="bold_gaming">Bold Gaming (Outlined)</option>
                                <option value="clean_minimal">Clean Minimal</option>
                                <option value="boxed_high_contrast">Boxed High Contrast</option>
                              </select>
                            </label>

                            <div className="flex items-end">
                              <Button
                                size="sm"
                                variant="outline"
                                className="w-full"
                                onClick={addCaptionCue}
                              >
                                <Plus className="h-3.5 w-3.5" />
                                Add Caption Cue
                              </Button>
                            </div>
                          </div>

                          {unreviewedCount > 0 && (
                            <div className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-xs text-amber-200">
                              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                              <div>
                                <p className="font-medium">
                                  {unreviewedCount} caption cue{unreviewedCount === 1 ? "" : "s"} flagged for review
                                </p>
                                <p className="mt-0.5 text-amber-200/80">
                                  ClipForge never invents words when transcription confidence is low or Whisper is not configured. Edit uncertain cues below or click Approve before rendering.
                                </p>
                              </div>
                            </div>
                          )}

                          {draftCaptions.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                              No caption cues in this time range yet. Click &ldquo;Add Caption Cue&rdquo; to author synced subtitles.
                            </div>
                          ) : (
                            <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                              {draftCaptions.map((cue, idx) => (
                                <div
                                  key={cue.id}
                                  className={`rounded-lg border p-2.5 ${
                                    cue.needsReview
                                      ? "border-amber-500/45 bg-amber-500/10"
                                      : "border-border bg-secondary/20"
                                  }`}
                                >
                                  <div className="flex flex-wrap items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => seekTo(cue.startSec)}
                                      className="font-mono text-[11px] text-primary hover:underline"
                                    >
                                      {formatTimePrecise(cue.startSec)} → {formatTimePrecise(cue.endSec)}
                                    </button>
                                    <Badge variant={cue.needsReview ? "warning" : "secondary"}>
                                      {cue.needsReview
                                        ? `Needs review (${Math.round(cue.confidence * 100)}%)`
                                        : `Conf ${Math.round(cue.confidence * 100)}%`}
                                    </Badge>
                                    <div className="ml-auto flex items-center gap-1">
                                      {cue.needsReview && (
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-6 px-2 text-[11px]"
                                          onClick={() =>
                                            updateCaptionCue(idx, {
                                              needsReview: false,
                                              confidence: 1,
                                            })
                                          }
                                        >
                                          <Check className="h-3 w-3" />
                                          Mark Reviewed
                                        </Button>
                                      )}
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                                        onClick={() => removeCaptionCue(idx)}
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  </div>
                                  <Input
                                    value={cue.text}
                                    onChange={(e) =>
                                      updateCaptionCue(idx, {
                                        text: e.target.value,
                                        needsReview: false,
                                        confidence: 1,
                                      })
                                    }
                                    className="mt-2 h-8 text-xs"
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* TAB 3: EXPORT MP4 PRESETS & RENDER QUEUE */}
                      {activeTab === "export" && (
                        <div className="space-y-5">
                          <div className="space-y-2">
                            <p className="text-xs font-medium text-muted-foreground">
                              Choose Platform-Friendly 9:16 MP4 Presets (Local Download Only — No Auto-Posting)
                            </p>
                            <div className="grid gap-2.5 sm:grid-cols-3">
                              {(Object.keys(EXPORT_PRESETS) as ExportPreset[]).map((presetKey) => {
                                const spec = EXPORT_PRESETS[presetKey];
                                const active = selectedPresets.includes(presetKey);
                                return (
                                  <button
                                    key={presetKey}
                                    type="button"
                                    onClick={() => togglePreset(presetKey)}
                                    className={`rounded-md border p-3 text-left transition-colors ${
                                      active
                                        ? "border-primary/80 bg-secondary/60 text-foreground"
                                        : "border-border/80 bg-secondary/20 text-muted-foreground hover:border-border hover:text-foreground"
                                    }`}
                                  >
                                    <div className="flex items-center justify-between">
                                      <span className="text-xs font-medium text-foreground">{spec.label}</span>
                                      {active && <CheckCircle2 className="h-3.5 w-3.5 text-primary" />}
                                    </div>
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                      {spec.description}
                                    </p>
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2.5">
                            <Button
                              onClick={() => void handleRender([selectedClip.id])}
                              disabled={rendering || selectedClip.status === "discarded"}
                              size="sm"
                            >
                              {rendering ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Film className="h-3.5 w-3.5" />
                              )}
                              Render 9:16 Clip ({selectedPresets.length})
                            </Button>

                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                void handleRender(selectedCandidates.map((c) => c.id))
                              }
                              disabled={rendering || selectedCandidates.length === 0}
                            >
                              Render All Selected ({selectedCandidates.length})
                            </Button>
                          </div>

                          {/* Render Exports History & Downloads */}
                          <div className="space-y-2.5">
                            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              Rendered MP4 Exports ({job.renderExports.length})
                            </h3>

                            {job.renderExports.length === 0 ? (
                              <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                                No vertical renders yet. Pick presets above and click Render to generate downloadable 1080×1920 MP4s.
                              </div>
                            ) : (
                              <div className="space-y-2.5">
                                {job.renderExports.map((exp: RenderExportDto) => (
                                  <div
                                    key={exp.id}
                                    className="rounded-lg border border-border bg-secondary/25 p-3.5"
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <div>
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="text-xs font-semibold">
                                            {exp.clip?.title ?? "Clip"}
                                          </span>
                                          <Badge variant="secondary">
                                            {EXPORT_PRESETS[exp.preset].label}
                                          </Badge>
                                          <Badge
                                            variant={
                                              exp.status === "complete"
                                                ? "success"
                                                : exp.status === "failed"
                                                  ? "destructive"
                                                  : "default"
                                            }
                                          >
                                            {exp.status}
                                          </Badge>
                                        </div>
                                        <p className="mt-1 text-[11px] text-muted-foreground">
                                          {exp.width}×{exp.height} · {exp.layoutMode.replaceAll("_", " ")} ·{" "}
                                          {exp.outputFileSizeBytes
                                            ? formatBytes(exp.outputFileSizeBytes)
                                            : exp.progressMessage ?? "Pending"}
                                        </p>
                                        {exp.status === "complete" && exp.progressMessage?.startsWith("Saved to ") && (
                                          <div className="mt-1.5 flex items-center gap-1.5 rounded bg-secondary/40 px-2 py-0.5 text-[10px] text-muted-foreground">
                                            <span className="truncate font-mono">{exp.progressMessage}</span>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                void navigator.clipboard.writeText(
                                                  exp.progressMessage!.replace("Saved to ", ""),
                                                )
                                              }
                                              className="ml-auto shrink-0 font-sans text-primary hover:underline"
                                            >
                                              Copy Path
                                            </button>
                                          </div>
                                        )}
                                      </div>

                                      <div className="flex items-center gap-2">
                                        {exp.status === "complete" && (
                                          <>
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              onClick={() =>
                                                setPreviewExportId((prev) =>
                                                  prev === exp.id ? null : exp.id,
                                                )
                                              }
                                            >
                                              <Play className="h-3.5 w-3.5" />
                                              {previewExportId === exp.id ? "Hide" : "Preview"}
                                            </Button>
                                            <a href={`/api/exports/${exp.id}/download`}>
                                              <Button size="sm">
                                                <Download className="h-3.5 w-3.5" />
                                                Download MP4
                                              </Button>
                                            </a>
                                          </>
                                        )}
                                        {exp.status === "failed" && (
                                          <Button
                                            size="sm"
                                            variant="destructive"
                                            onClick={() => void handleRetryExport(exp.id)}
                                          >
                                            <RotateCcw className="h-3.5 w-3.5" />
                                            Retry
                                          </Button>
                                        )}
                                      </div>
                                    </div>

                                    {(exp.status === "queued" || exp.status === "rendering") && (
                                      <div className="mt-2.5 space-y-1">
                                        <Progress value={exp.progressPct} />
                                        <p className="text-[11px] text-muted-foreground">
                                          {exp.progressMessage ?? "Rendering..."} ({exp.progressPct}%)
                                        </p>
                                      </div>
                                    )}

                                    {exp.status === "failed" && exp.errorMessage && (
                                      <p className="mt-2 text-xs text-red-400">
                                        {exp.errorMessage}
                                      </p>
                                    )}

                                    {previewExportId === exp.id && exp.status === "complete" && (
                                      <div className="mt-3 flex justify-center rounded-lg bg-black/80 p-3">
                                        <video
                                          src={`/api/exports/${exp.id}/download?inline=1`}
                                          controls
                                          className="max-h-[420px] rounded-lg border border-border"
                                        />
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function SignalMiniBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, Math.round((value ?? 0) * 100)));
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full bg-primary/80" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
