import { NextRequest, NextResponse } from "next/server";
import {
  AuthorizedUploadIngestionProvider,
  OfficialYouTubeMetadataProvider,
  inspectYoutubeSchema,
  parseYouTubeUrl,
} from "@clipforge/core";
import { requireUser } from "@/lib/session";
import { handleApiError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    await requireUser();
    const body = await request.json();
    const { url } = inspectYoutubeSchema.parse(body);

    const parsed = parseYouTubeUrl(url);
    const metadataProvider = new OfficialYouTubeMetadataProvider();
    const ingestionProvider = new AuthorizedUploadIngestionProvider();

    const [metadata, ingestionCheck] = await Promise.all([
      metadataProvider.fetchMetadata(parsed),
      ingestionProvider.canIngestDirectly(parsed.videoId),
    ]);

    return NextResponse.json({
      parsed,
      metadata,
      ingestion: {
        providerId: ingestionProvider.id,
        providerName: ingestionProvider.displayName,
        requiresUserUpload: ingestionProvider.requiresUserUpload,
        directAccessAllowed: ingestionCheck.allowed,
        reason: ingestionCheck.reason,
      },
    });
  } catch (error) {
    return handleApiError(error, { route: "POST /api/youtube/inspect" });
  }
}
