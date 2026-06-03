import crypto from "node:crypto";
import express, { type Express, type Request } from "express";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  jwtVerify,
  SignJWT,
} from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const ID_JAG_JWT_TYPE = "oauth-id-jag+jwt";
const ACCESS_TOKEN_TTL_SECONDS = 600;
const DEFAULT_PORT = 3458;
const DEFAULT_CLIENT_ID = "id-jag-resource-client";
const DEFAULT_CLIENT_SECRET = "id-jag-resource-secret";

type ServerConfig = {
  port: number;
  baseUrl: string;
  gatewayAudience: string;
  clientId: string;
  clientSecret: string;
};

type MintedAccessToken = {
  bearerToken: string;
  subject: string;
  email?: string;
  name?: string;
  resource: string;
  scope: string;
  tokenKind: "mcp_server_access_token";
  obtainedVia: "id_jag_jwt_bearer";
  expiresAtEpochSeconds: number;
};

export async function createApp(
  config: Partial<ServerConfig> = {},
): Promise<Express> {
  const resolvedConfig = getConfig(config);
  const demoIdp = await DemoIdentityProvider.create({
    issuer: `${resolvedConfig.baseUrl}/demo-idp`,
  });
  const accessTokens = new AccessTokenStore();
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource: `${resolvedConfig.baseUrl}/mcp`,
      authorization_servers: [resolvedConfig.baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["whoami"],
    });
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: resolvedConfig.baseUrl,
      token_endpoint: `${resolvedConfig.baseUrl}/token`,
      jwks_uri: `${demoIdp.issuer}/jwks`,
      grant_types_supported: [JWT_BEARER_GRANT_TYPE],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
      id_jag_token_type: ID_JAG_TOKEN_TYPE,
    });
  });

  app.get("/demo-idp/jwks", (_req, res) => {
    res.json({ keys: [demoIdp.publicJwk] });
  });

  app.post("/demo-idp/mint", async (req, res) => {
    const body = MintIdJagRequestSchema.parse(req.body);
    const assertion = await demoIdp.mintIdJag({
      subject: body.sub,
      email: body.email,
      name: body.name,
      audience: body.audience ?? [
        resolvedConfig.gatewayAudience,
        resolvedConfig.baseUrl,
        `${resolvedConfig.baseUrl}/mcp`,
      ],
      clientId: body.client_id ?? resolvedConfig.clientId,
      resource: body.resource ?? `${resolvedConfig.baseUrl}/mcp`,
      scope: body.scope ?? "whoami",
    });

    res.json({
      assertion,
      assertion_type: ID_JAG_TOKEN_TYPE,
      issuer: demoIdp.issuer,
      expires_in: 300,
    });
  });

  app.post("/token", async (req, res) => {
    if (!authenticateClient(req, resolvedConfig)) {
      res
        .status(401)
        .setHeader("WWW-Authenticate", 'Basic realm="mcp-server-id-jag"')
        .json(oauthError("invalid_client", "Client authentication failed"));
      return;
    }

    const body = TokenRequestSchema.parse(req.body);
    if (body.grant_type !== JWT_BEARER_GRANT_TYPE) {
      res.status(400).json(
        oauthError(
          "unsupported_grant_type",
          `Only ${JWT_BEARER_GRANT_TYPE} is supported`,
        ),
      );
      return;
    }

    try {
      const claims = await demoIdp.verifyIdJag({
        assertion: body.assertion,
        audience: resolvedConfig.baseUrl,
        clientId: resolvedConfig.clientId,
      });
      const minted = accessTokens.issue({
        subject: claims.sub,
        email: claims.email,
        name: claims.name,
        resource: claims.resource,
        scope: claims.scope,
        tokenKind: "mcp_server_access_token",
        obtainedVia: "id_jag_jwt_bearer",
      });

      res.json({
        access_token: minted.bearerToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: minted.scope,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      });
    } catch (error) {
      res.status(400).json(
        oauthError(
          "invalid_grant",
          error instanceof Error ? error.message : "The ID-JAG was rejected",
        ),
      );
    }
  });

  app.post("/mcp", async (req, res) => {
    const accessToken = accessTokens.read(extractBearerToken(req));
    if (!accessToken) {
      res
        .status(401)
        .setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${resolvedConfig.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
        )
        .json(oauthError("invalid_token", "A minted MCP access token is required"));
      return;
    }

    const server = new McpServer({
      name: "id-jag-demo-server",
      version: "1.0.0",
    });

    server.tool(
      "whoami",
      "Show the identity represented by the minted MCP access token",
      {},
      async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                bearerToken: accessToken.bearerToken,
                user: {
                  subject: accessToken.subject,
                  email: accessToken.email,
                  name: accessToken.name,
                },
                accessToken: {
                  resource: accessToken.resource,
                  scope: accessToken.scope,
                  tokenKind: accessToken.tokenKind,
                  obtainedVia: accessToken.obtainedVia,
                },
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
      enableJsonResponse: true,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    await server.close();
  });

  return app;
}

export async function startServer(
  config: Partial<ServerConfig> = {},
): Promise<void> {
  const resolvedConfig = getConfig(config);
  const app = await createApp(resolvedConfig);
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(resolvedConfig.port, "0.0.0.0", () => {
      console.log(`mcp-server-id-jag listening on ${resolvedConfig.baseUrl}`);
      resolve();
    });
    server.once("error", reject);
  });
}

const TokenRequestSchema = z.object({
  grant_type: z.string(),
  assertion: z.string().min(1),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
});

const MintIdJagRequestSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().optional(),
  audience: z.array(z.string()).optional(),
  client_id: z.string().optional(),
  resource: z.string().url().optional(),
  scope: z.string().optional(),
});

const VerifiedIdJagClaimsSchema = z.object({
  iss: z.string().url(),
  sub: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  jti: z.string(),
  client_id: z.string(),
  resource: z.string().url(),
  scope: z.string(),
  email: z.string().email().optional(),
  name: z.string().optional(),
});

type VerifiedIdJagClaims = z.infer<typeof VerifiedIdJagClaimsSchema>;

class DemoIdentityProvider {
  static async create(params: { issuer: string }): Promise<DemoIdentityProvider> {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const keyId = crypto.randomUUID();

    return new DemoIdentityProvider({
      issuer: params.issuer,
      keyId,
      publicJwk: { ...publicJwk, kid: keyId, use: "sig", alg: "RS256" },
      privateKey,
    });
  }

  public readonly issuer: string;
  public readonly publicJwk: JWK;
  private readonly keyId: string;
  private readonly privateKey: Parameters<SignJWT["sign"]>[0];

  private constructor(params: {
    issuer: string;
    keyId: string;
    publicJwk: JWK;
    privateKey: Parameters<SignJWT["sign"]>[0];
  }) {
    this.issuer = params.issuer;
    this.keyId = params.keyId;
    this.publicJwk = params.publicJwk;
    this.privateKey = params.privateKey;
  }

  async mintIdJag(params: {
    subject: string;
    email?: string;
    name?: string;
    audience: string[];
    clientId: string;
    resource: string;
    scope: string;
  }): Promise<string> {
    return await new SignJWT({
      client_id: params.clientId,
      resource: params.resource,
      scope: params.scope,
      ...(params.email ? { email: params.email } : {}),
      ...(params.name ? { name: params.name } : {}),
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: this.keyId,
        typ: ID_JAG_JWT_TYPE,
      })
      .setIssuer(this.issuer)
      .setSubject(params.subject)
      .setAudience(params.audience)
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(this.privateKey);
  }

  async verifyIdJag(params: {
    assertion: string;
    audience: string;
    clientId: string;
  }): Promise<VerifiedIdJagClaims> {
    const { payload, protectedHeader } = await jwtVerify(
      params.assertion,
      await importJWK(this.publicJwk, "RS256"),
      {
        issuer: this.issuer,
        audience: params.audience,
        clockTolerance: 30,
      },
    );

    if (protectedHeader.typ !== ID_JAG_JWT_TYPE) {
      throw new Error(`Expected ${ID_JAG_JWT_TYPE} assertion type`);
    }
    const claims = VerifiedIdJagClaimsSchema.parse(payload);
    if (claims.client_id !== params.clientId) {
      throw new Error("ID-JAG client_id does not match this MCP server");
    }
    return claims;
  }
}

class AccessTokenStore {
  private readonly tokens = new Map<string, MintedAccessToken>();

  issue(params: Omit<MintedAccessToken, "bearerToken" | "expiresAtEpochSeconds">) {
    const token: MintedAccessToken = {
      ...params,
      bearerToken: `mcp-server-at-${crypto.randomUUID()}`,
      expiresAtEpochSeconds:
        Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    };
    this.tokens.set(token.bearerToken, token);
    return token;
  }

  read(token: string | null): MintedAccessToken | null {
    if (!token) return null;
    const stored = this.tokens.get(token);
    if (!stored) return null;
    if (stored.expiresAtEpochSeconds <= Math.floor(Date.now() / 1000)) {
      this.tokens.delete(token);
      return null;
    }
    return stored;
  }
}

function authenticateClient(req: Request, config: ServerConfig): boolean {
  const basic = req.headers.authorization?.match(/^Basic\s+(.+)$/i);
  if (basic) {
    const [clientId, clientSecret] = Buffer.from(basic[1], "base64")
      .toString("utf8")
      .split(":");
    return clientId === config.clientId && clientSecret === config.clientSecret;
  }
  return (
    req.body.client_id === config.clientId &&
    req.body.client_secret === config.clientSecret
  );
}

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length);
}

function oauthError(error: string, errorDescription: string) {
  return { error, error_description: errorDescription };
}

function getConfig(config: Partial<ServerConfig> = {}): ServerConfig {
  const port = config.port ?? Number(process.env.PORT || DEFAULT_PORT);
  const baseUrl = config.baseUrl ?? process.env.BASE_URL ?? `http://127.0.0.1:${port}`;
  return {
    port,
    baseUrl,
    gatewayAudience:
      config.gatewayAudience ??
      process.env.GATEWAY_AUDIENCE ??
      "id-jag-gateway-client",
    clientId:
      config.clientId ?? process.env.CLIENT_ID ?? DEFAULT_CLIENT_ID,
    clientSecret:
      config.clientSecret ?? process.env.CLIENT_SECRET ?? DEFAULT_CLIENT_SECRET,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
