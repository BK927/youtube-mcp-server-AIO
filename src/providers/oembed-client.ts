import { YouTubeMcpError } from "../errors.js";
import { videoUrl } from "../utils/ids.js";

interface OEmbedResponse {
  title?: unknown;
  author_name?: unknown;
  author_url?: unknown;
  thumbnail_url?: unknown;
  thumbnail_width?: unknown;
  thumbnail_height?: unknown;
}

export class OEmbedClient {
  constructor(private readonly timeoutMs: number) {}

  async getVideo(videoId: string): Promise<Record<string, unknown>> {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.searchParams.set("url", videoUrl(videoId));
    endpoint.searchParams.set("format", "json");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(endpoint, { signal: controller.signal });
      if (!response.ok) {
        throw new YouTubeMcpError(
          "OEMBED_REQUEST_FAILED",
          `YouTube oEmbed returned HTTP ${response.status}.`,
          { videoId, status: response.status },
        );
      }
      const data = (await response.json()) as OEmbedResponse;
      return {
        id: videoId,
        url: videoUrl(videoId),
        title: typeof data.title === "string" ? data.title : null,
        channelTitle:
          typeof data.author_name === "string" ? data.author_name : null,
        channelUrl:
          typeof data.author_url === "string" ? data.author_url : null,
        thumbnailUrl:
          typeof data.thumbnail_url === "string" ? data.thumbnail_url : null,
        thumbnailWidth:
          typeof data.thumbnail_width === "number" ? data.thumbnail_width : null,
        thumbnailHeight:
          typeof data.thumbnail_height === "number" ? data.thumbnail_height : null,
        provider: "youtube-oembed",
        completeness: "limited",
        missingWithoutApiKey: [
          "description",
          "publishedAt",
          "duration",
          "statistics",
          "tags",
          "category",
          "live status",
        ],
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
