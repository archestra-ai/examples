import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json());

// Valid GitHub tokens (in production, you'd validate against GitHub's API)
const VALID_TOKENS: Record<string, { login: string; name: string }> = {
  ghp_alice_github_token_mock_abc123: {
    login: "alice-gh",
    name: "Alice Smith",
  },
  ghp_bob_github_token_mock_def456: { login: "bob-gh", name: "Bob Jones" },
};

// Simple auth middleware — validates GitHub-style tokens
function requireGitHubToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing GitHub token" });
    return;
  }

  const token = authHeader.slice(7);
  const user = VALID_TOKENS[token];
  if (!user) {
    res
      .status(401)
      .json({ error: "Invalid GitHub token", message: "Bad credentials" });
    return;
  }

  (req as any).githubUser = user;
  next();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", requireGitHubToken, async (req, res) => {
  const githubUser = (req as any).githubUser as {
    login: string;
    name: string;
  };

  const server = new McpServer({
    name: "github-mcp-server",
    version: "1.0.0",
  });

  // Register GitHub-like tools
  server.tool(
    "list-repos",
    "List GitHub repositories for the authenticated user",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              user: githubUser.login,
              repos: [
                {
                  name: "my-app",
                  full_name: `${githubUser.login}/my-app`,
                  private: false,
                  language: "TypeScript",
                  stars: 42,
                },
                {
                  name: "internal-tools",
                  full_name: `${githubUser.login}/internal-tools`,
                  private: true,
                  language: "Python",
                  stars: 7,
                },
              ],
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.tool(
    "create-issue",
    "Create a GitHub issue",
    {
      repo: z.string().describe("Repository name (owner/repo)"),
      title: z.string().describe("Issue title"),
      body: z.string().optional().describe("Issue body"),
    },
    async ({ repo, title, body }) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              id: Math.floor(Math.random() * 10000),
              number: Math.floor(Math.random() * 500),
              title,
              body: body || "",
              state: "open",
              html_url: `https://github.com/${repo}/issues/${Math.floor(Math.random() * 500)}`,
              user: { login: githubUser.login },
              created_at: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.tool(
    "get-authenticated-user",
    "Get the currently authenticated GitHub user",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              login: githubUser.login,
              name: githubUser.name,
              type: "User",
              plan: "enterprise",
              message:
                "This token was exchanged from a Keycloak JWT by the gateway",
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  await server.close();
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed (stateless server)" });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed (stateless server)" });
});

const PORT = Number(process.env.PORT) || 3457;
app.listen(PORT, () => {
  console.log(`Mock GitHub MCP server listening on http://localhost:${PORT}`);
  console.log(
    `Valid tokens: ${Object.keys(VALID_TOKENS).map((t) => t.slice(0, 12) + "...").join(", ")}`,
  );
});
