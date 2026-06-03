import crypto from "node:crypto";
import express, { type Express } from "express";
import {
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  jwtVerify,
  SignJWT,
} from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const OBO_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const DEFAULT_PORT = 3456;

type AppConfig = {
  port: number;
  baseUrl: string;
  tenantId: string;
  gatewayAudience: string;
  gatewayClientId: string;
  gatewayClientSecret: string;
  mcpScope: string;
  mcpAudience: string;
  localDemoMode: boolean;
};

type DemoIssuer = {
  issuer: string;
  publicJwk: JWK;
  mintToken: (params: {
    audience: string;
    subject?: string;
    username?: string;
    scopes?: string;
  }) => Promise<string>;
};

export async function createApp(config: Partial<AppConfig> = {}): Promise<Express> {
  const resolvedConfig = getConfig(config);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const demoIssuer = resolvedConfig.localDemoMode
    ? await createDemoIssuer(`${resolvedConfig.baseUrl}/demo-entra`)
    : null;
  const issuer = demoIssuer?.issuer ?? `https://login.microsoftonline.com/${resolvedConfig.tenantId}/v2.0`;
  const jwks = demoIssuer
    ? createRemoteJWKSet(new URL(`${demoIssuer.issuer}/jwks`))
    : createRemoteJWKSet(
        new URL(
          `https://login.microsoftonline.com/${resolvedConfig.tenantId}/discovery/v2.0/keys`,
        ),
      );
  const tokenEndpoint = demoIssuer
    ? `${resolvedConfig.baseUrl}/demo-entra/token`
    : `https://login.microsoftonline.com/${resolvedConfig.tenantId}/oauth2/v2.0/token`;

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/gateway/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: `${resolvedConfig.baseUrl}/gateway/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [],
    });
  });

  if (demoIssuer) {
    app.get("/demo-entra/jwks", (_req, res) => {
      res.json({ keys: [demoIssuer.publicJwk] });
    });

    app.post("/demo-entra/mint-gateway-token", async (req, res) => {
      const body = MintGatewayTokenSchema.parse(req.body);
      res.json({
        access_token: await demoIssuer.mintToken({
          audience: resolvedConfig.gatewayAudience,
          subject: body.sub,
          username: body.username,
          scopes: body.scopes,
        }),
        token_type: "Bearer",
        expires_in: 300,
      });
    });

    app.post("/demo-entra/token", async (req, res) => {
      if (
        req.body.grant_type !== OBO_GRANT_TYPE ||
        req.body.requested_token_use !== "on_behalf_of"
      ) {
        res.status(400).json({
          error: "unsupported_grant_type",
          error_description: "This demo endpoint only supports Entra OBO.",
        });
        return;
      }

      if (
        req.body.client_id !== resolvedConfig.gatewayClientId ||
        req.body.client_secret !== resolvedConfig.gatewayClientSecret
      ) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }

      const { payload } = await jwtVerify(req.body.assertion, jwks, {
        issuer,
        audience: resolvedConfig.gatewayAudience,
        clockTolerance: 30,
      });

      res.json({
        access_token: await demoIssuer.mintToken({
          audience: resolvedConfig.mcpAudience,
          subject: String(payload.sub ?? "demo-user"),
          username: String(payload.preferred_username ?? "demo@example.com"),
          scopes: resolvedConfig.mcpScope.split("/").at(-1) ?? "MCP.Access",
        }),
        token_type: "Bearer",
        expires_in: 300,
      });
    });
  }

  app.post("/gateway/mcp", async (req, res) => {
    const assertion = extractBearerToken(req.headers.authorization);
    if (!assertion) {
      res.status(401).json({ error: "Missing gateway Authorization header" });
      return;
    }

    try {
      const caller = await verifyToken({
        token: assertion,
        jwks,
        issuer,
        audience: resolvedConfig.gatewayAudience,
      });
      const mcpAccessToken = await exchangeOnBehalfOf({
        assertion,
        tokenEndpoint,
        config: resolvedConfig,
      });

      const upstreamResponse = await fetch(`${resolvedConfig.baseUrl}/upstream/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: req.headers.accept || "application/json, text/event-stream",
          Authorization: `Bearer ${mcpAccessToken}`,
        },
        body: JSON.stringify(req.body),
      });

      const body = await upstreamResponse.text();
      const contentType = upstreamResponse.headers.get("content-type");
      res.status(upstreamResponse.status);
      if (contentType) res.set("content-type", contentType);
      res.set(
        "x-demo-caller",
        String(caller.preferred_username ?? caller.sub ?? ""),
      );
      res.send(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(401).json({
        error: "Gateway OBO flow failed",
        details: message,
      });
    }
  });

  app.post("/upstream/mcp", async (req, res) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({ error: "Missing upstream Authorization header" });
      return;
    }

    try {
      const auth = await verifyToken({
        token,
        jwks,
        issuer,
        audience: resolvedConfig.mcpAudience,
      });
      const server = new McpServer({
        name: "entra-obo-upstream-mcp",
        version: "1.0.0",
      });

      server.tool(
        "debug-auth-token",
        "Show the Entra access token metadata received by the upstream MCP server",
        {},
        async () => ({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  authorizationHeaderPresent: true,
                  subject: auth.sub,
                  username: auth.preferred_username,
                  audience: auth.aud,
                  scopes: auth.scp,
                  appRoles: auth.roles,
                  issuer: auth.iss,
                },
                null,
                2,
              ),
            },
          ],
        }),
      );

      server.tool(
        "echo",
        "Echo text after validating the downstream MCP access token",
        { text: z.string().describe("Text to echo") },
        async ({ text }) => ({
          content: [{ type: "text" as const, text }],
        }),
      );

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      await server.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(401).json({
        error: "Invalid upstream MCP access token",
        details: message,
      });
    }
  });

  return app;
}

export async function startServer(
  config: Partial<AppConfig> = {},
): Promise<void> {
  const resolvedConfig = getConfig(config);
  const app = await createApp(resolvedConfig);
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(resolvedConfig.port, "0.0.0.0", () => {
      console.log(`Entra OBO MCP demo listening on ${resolvedConfig.baseUrl}`);
      resolve();
    });
    server.once("error", reject);
  });
}

async function exchangeOnBehalfOf(params: {
  assertion: string;
  tokenEndpoint: string;
  config: AppConfig;
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: params.config.gatewayClientId,
    client_secret: params.config.gatewayClientSecret,
    grant_type: OBO_GRANT_TYPE,
    assertion: params.assertion,
    requested_token_use: "on_behalf_of",
    scope: params.config.mcpScope,
  });

  const response = await fetch(params.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(
      `Token endpoint returned ${response.status}: ${
        payload.error_description || payload.error || "missing access_token"
      }`,
    );
  }

  return payload.access_token;
}

async function verifyToken(params: {
  token: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  issuer: string;
  audience: string;
}) {
  const { payload } = await jwtVerify(params.token, params.jwks, {
    issuer: params.issuer,
    audience: params.audience,
    clockTolerance: 30,
  });
  return payload;
}

async function createDemoIssuer(issuer: string): Promise<DemoIssuer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const keyId = crypto.randomUUID();

  return {
    issuer,
    publicJwk: { ...publicJwk, kid: keyId, use: "sig", alg: "RS256" },
    mintToken: async ({ audience, subject, username, scopes }) =>
      await new SignJWT({
        tid: "demo-tenant",
        preferred_username: username ?? "demo@example.com",
        scp: scopes ?? "access_as_user",
      })
        .setProtectedHeader({ alg: "RS256", kid: keyId })
        .setIssuer(issuer)
        .setSubject(subject ?? "demo-user")
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey),
  };
}

const MintGatewayTokenSchema = z.object({
  sub: z.string().default("demo-user"),
  username: z.string().email().default("demo@example.com"),
  scopes: z.string().default("access_as_user"),
});

function getConfig(config: Partial<AppConfig> = {}): AppConfig {
  const port = config.port ?? Number(process.env.PORT || DEFAULT_PORT);
  const baseUrl = config.baseUrl ?? process.env.BASE_URL ?? `http://127.0.0.1:${port}`;
  const localDemoMode =
    config.localDemoMode ??
    (process.env.LOCAL_DEMO_MODE
      ? process.env.LOCAL_DEMO_MODE !== "false"
      : true);

  return {
    port,
    baseUrl,
    localDemoMode,
    tenantId: config.tenantId ?? process.env.ENTRA_TENANT_ID ?? "demo-tenant",
    gatewayAudience:
      config.gatewayAudience ??
      process.env.GATEWAY_AUDIENCE ??
      "api://demo-gateway",
    gatewayClientId:
      config.gatewayClientId ??
      process.env.GATEWAY_CLIENT_ID ??
      "demo-gateway-client",
    gatewayClientSecret:
      config.gatewayClientSecret ??
      process.env.GATEWAY_CLIENT_SECRET ??
      "demo-gateway-secret",
    mcpScope:
      config.mcpScope ??
      process.env.MCP_SCOPE ??
      "api://demo-upstream-mcp/MCP.Access",
    mcpAudience:
      config.mcpAudience ??
      process.env.MCP_AUDIENCE ??
      "api://demo-upstream-mcp",
  };
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
