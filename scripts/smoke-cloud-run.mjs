import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const expected = [
  "youtube_video_get",
  "youtube_search",
  "youtube_channel_get",
  "youtube_playlist_get",
];

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const url = args.get("--url");
const video = args.get("--video") ?? "dQw4w9WgXcQ";
const token = process.env.MCP_SMOKE_ACCESS_TOKEN;
if (!url || !token) {
  throw new Error("--url and MCP_SMOKE_ACCESS_TOKEN are required");
}

const client = new Client({ name: "youtube-cloud-smoke", version: "1.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  authProvider: { token: async () => token },
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`exact tools/list mismatch: ${JSON.stringify(names)}`);
  }
  const result = await client.callTool({
    name: "youtube_video_get",
    arguments: {
      video,
      view: "transcript",
      options: { include_text: false, include_timestamps: true },
      limit: 1,
      max_chars: 512,
    },
  });
  if (result.isError) {
    throw new Error("representative keyless transcript call returned isError");
  }
  console.log("YouTube MCP SDK smoke passed: exact 4 tools and keyless transcript call.");
} finally {
  await client.close();
}
