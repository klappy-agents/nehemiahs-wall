import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { makeHandlers } from "./tools.js";

// Official SDK, Streamable HTTP, stateless — borrowed, not hand-rolled (agent-role-service pattern).
export async function handleMcp(request, env, grant) {
  const h = makeHandlers(env, grant);
  const server = new McpServer({ name: "nehemiahs-wall", version: env.VERSION ?? "0.0.0-scaffold" });
  const asText = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
  server.registerTool("docs", { description: "How to play Nehemiah's Wall as the Watchman, live." }, async () => asText((await h.docs()).text));
  server.registerTool(
    "execute",
    {
      description: "Join, look or act in a room. One verb; the op picks the capability.",
      inputSchema: {
        room: z.string().describe("Room capability id from the private room link"),
        seat: z.enum(["builder", "watchman"]).optional(),
        op: z.enum(["join", "look", "act"]),
        action: z.string().optional(),
        expectedRev: z.number().int().optional(),
        requestId: z.string().optional(),
      },
    },
    async (args) => asText(await h.execute(args)),
  );
  server.registerTool("telemetry", { description: "The same numbers the maintainer sees." }, async () => asText(await h.telemetry()));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
