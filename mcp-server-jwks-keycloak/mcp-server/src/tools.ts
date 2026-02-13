import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthContext } from "./auth.js";

export function registerTools(server: McpServer, auth: AuthContext): void {
  server.tool(
    "get-server-info",
    "Get MCP server information and your authentication details",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              server: "MCP JWKS Demo Server",
              version: "1.0.0",
              user: {
                sub: auth.sub,
                email: auth.email,
                name: auth.name,
                roles: auth.roles,
              },
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.tool(
    "query-database",
    "Query the database (requires db-reader role)",
    { query: z.string().describe("SQL query to execute") },
    async ({ query }) => {
      if (!auth.roles.includes("db-reader")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Access denied: you need the 'db-reader' role to use this tool.",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                results: [
                  { id: 1, name: "Widget A", price: 29.99 },
                  { id: 2, name: "Widget B", price: 49.99 },
                  { id: 3, name: "Widget C", price: 99.99 },
                ],
                rowCount: 3,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
