"use client";

import { useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileVideo, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/utils";

const ALLOWED_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".mkv"];

export function UploadZone({
  jobId,
  maxUploadBytes,
  onUploadComplete,
}: {
  jobId: string;
  maxUploadBytes: number;
  onUploadComplete: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function validateClientFile(file: File): string | null {
    if (file.size <= 0) return "Selected file is empty.";
    if (file.size > maxUploadBytes) {
      return `File is too large (${formatBytes(file.size)}). Maximum allowed size is ${formatBytes(maxUploadBytes)}.`;
    }
    const lower = file.name.toLowerCase();
    if (!ALLOWED_EXTS.some((ext) => lower.endsWith(ext))) {
      return `Unsupported file format. Please select an MP4, MOV, M4V, WebM, or MKV video.`;
    }
    return null;
  }

  function handleSelect(file: File | null) {
    setError(null);
    setDone(false);
    if (!file) return;
    const validationErr = validateClientFile(file);
    if (validationErr) {
      setError(validationErr);
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
  }

  function startUpload() {
    if (!selectedFile || uploading) return;
    setError(null);
    setUploading(true);
    setProgressPct(0);
    setUploadedBytes(0);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/jobs/${jobId}/upload`);
    xhr.setRequestHeader("Content-Type", selectedFile.type || "video/mp4");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(selectedFile.name));

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        setUploadedBytes(evt.loaded);
        setProgressPct(Math.min(99, Math.round((evt.loaded / evt.total) * 100)));
      }
    };

    xhr.onload = () => {
      setUploading(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        setProgressPct(100);
        setDone(true);
        onUploadComplete();
      } else {
        try {
          const parsed = JSON.parse(xhr.responseText);
          setError(parsed.error ?? `Upload failed (HTTP ${xhr.status}).`);
        } catch {
          setError(`Upload failed (HTTP ${xhr.status}).`);
        }
      }
    };

    xhr.onerror = () => {
      setUploading(false);
      setError("Network error interrupted the upload. Please try again.");
    };

    xhr.send(selectedFile);
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0] ?? null;
          handleSelect(file);
        }}
        className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition ${
          dragOver
            ? "border-primary bg-primary/10"
            : "border-border bg-secondary/25 hover:border-primary/50"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".mp4,.mov,.m4v,.webm,.mkv,video/mp4,video/quicktime,video/webm,video/x-matroska"
          className="hidden"
          onChange={(e) => handleSelect(e.target.files?.[0] ?? null)}
        />
        <UploadCloud className="mb-3 h-10 w-10 text-primary" />
        <p className="text-sm font-medium">
          Drop your authorized gaming recording here, or browse your computer
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          MP4, MOV, WebM, or MKV · Up to {formatBytes(maxUploadBytes)} · Stored in configured object storage
        </p>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          Choose Video File
        </Button>
      </div>

      {selectedFile && (
        <div className="rounded-lg border border-border bg-secondary/35 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <FileVideo className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm font-medium">{selectedFile.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(selectedFile.size)} · {selectedFile.type || "video"}
                </p>
              </div>
            </div>
            <Button onClick={startUpload} disabled={uploading || done}>
              {uploading
                ? `Uploading ${progressPct}%...`
                : done
                  ? "Uploaded — Starting Analysis"
                  : "Upload & Analyze Video"}
            </Button>
          </div>

          {(uploading || done) && (
            <div className="mt-3 space-y-1.5">
              <Progress value={progressPct} />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {done
                    ? "Verified & queued for background worker"
                    : `${formatBytes(uploadedBytes)} / ${formatBytes(selectedFile.size)}`}
                </span>
                <span>{progressPct}%</span>
              </div>
            </div>
          )}
        </div>
      )}

      {done && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Upload complete. Background analysis has started — you can safely leave this page and return anytime.
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
