import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { makeHandlers } from "./tools.js";

// Official SDK, Streamable HTTP, stateless — borrowed from the SDK itself, not hand-rolled.
export async function handleMcp(request, env, grant, ctx = {}) {
  const h = makeHandlers(env, grant, ctx);
  const server = new McpServer({ name: "nehemiahs-wall", version: env.VERSION ?? "0.0.0-scaffold" });
  const asText = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }], ...(v && v.error ? { isError: true } : {}) });
  server.registerTool("docs", { description: "How to play Nehemiah's Wall as the Watchman, live." }, async () => asText((await h.docs()).text));
  server.registerTool(
    "execute",
    {
      description: "Create, join, look or act in a room; invite, claim or rotate a seat. One verb; the op picks the capability.",
      inputSchema: {
        room: z.string().optional().describe("Room id (not needed for op create)"),
        seat: z.enum(["builder", "watchman"]).optional(),
        op: z.enum(["create", "join", "look", "act", "invite", "claim", "rotate"]),
        cap: z.string().optional().describe("Your seat token for this room (capability mode). Never share it."),
        code: z.string().optional().describe("Single-use claim code from a Watchman invite (op claim)"),
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
