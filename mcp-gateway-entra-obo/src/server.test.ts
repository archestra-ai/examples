import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createApp } from "./server.js";

test("exchanges a gateway token for a downstream MCP bearer token", async () => {
  const { baseUrl, close } = await startTestServer();

  try {
    const gatewayToken = await mintGatewayToken(baseUrl);
    const result = await callDebugAuthToken(baseUrl, gatewayToken);

    assert.equal(result.authorizationHeaderPresent, true);
    assert.equal(result.audience, "api://demo-upstream-mcp");
    assert.equal(result.scopes, "MCP.Access");
    assert.equal(result.username, "demo@example.com");
  } finally {
    await close();
  }
});

test("does not allow the original gateway token at the upstream MCP server", async () => {
  const { baseUrl, close } = await startTestServer();

  try {
    const gatewayToken = await mintGatewayToken(baseUrl);
    const response = await fetch(`${baseUrl}/upstream/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });

    assert.equal(response.status, 401);
  } finally {
    await close();
  }
});

async function startTestServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = await createApp({ baseUrl, port, localDemoMode: true });
  const appServer = http.createServer(app);
  await new Promise<void>((resolve) => {
    appServer.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        appServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function mintGatewayToken(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/demo-entra/mint-gateway-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sub: "demo-user",
      username: "demo@example.com",
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

async function callDebugAuthToken(baseUrl: string, gatewayToken: string) {
  const response = await fetch(`${baseUrl}/gateway/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "debug-auth-token",
        arguments: {},
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }> };
  };
  return JSON.parse(body.result.content[0]?.text) as {
    authorizationHeaderPresent: boolean;
    audience: string;
    scopes: string;
    username: string;
  };
}
