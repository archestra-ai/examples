import crypto from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
  SignJWT,
} from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const GRANT_TYPE_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const ID_JAG_JWT_TYPE = "oauth-id-jag+jwt";
const ACCESS_TOKEN_TTL_SECONDS = 60 * 10;
const DEFAULT_PORT = 3458;
const DEFAULT_BASE_URL = `http://localhost:${DEFAULT_PORT}`;
const DEFAULT_CLIENT_ID = "demo-client";
const DEFAULT_CLIENT_SECRET = "demo-secret";

type DemoClient = {
  clientId: string;
  clientSecret: string;
};

type MintedAccessToken = {
  accessToken: string;
  clientId: string;
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  scope: string;
  resource?: string;
  expiresAtEpochSeconds: number;
};

type ServerConfig = {
  port: number;
  baseUrl: string;
  client: DemoClient;
};

type DemoIdJagClaims = {
  client_id: string;
  scope?: string;
  resource?: string;
  sub: string;
  email?: string;
  name?: string;
};

type AuthedRequest = Request & {
  accessToken?: MintedAccessToken;
};

export async function createApp(config: Partial<ServerConfig> = {}): Promise<Express> {
  const resolvedConfig = getServerConfig(config);
  const app = express();
  const accessTokenStore = new AccessTokenStore();
  const demoIdentityProvider = await DemoIdentityProvider.create({
    baseUrl: resolvedConfig.baseUrl,
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
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
      grant_types_supported: [GRANT_TYPE_JWT_BEARER],
      response_types_supported: [],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      identity_chaining_requested_token_types_supported: [ID_JAG_TOKEN_TYPE],
    });
  });

  app.get("/demo-idp/.well-known/openid-configuration", (_req, res) => {
    res.json({
      issuer: demoIdentityProvider.issuer,
      jwks_uri: `${demoIdentityProvider.issuer}/jwks`,
    });
  });

  app.get("/demo-idp/jwks", (_req, res) => {
    res.json({
      keys: [demoIdentityProvider.publicJwk],
    });
  });

  app.post("/demo-idp/mint", async (req, res) => {
    const body = MintIdJagRequestSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: "invalid_request",
        error_description: body.error.issues.map((issue) => issue.message).join(", "),
      });
      return;
    }

    const assertion = await demoIdentityProvider.mintIdJag({
      client_id: body.data.client_id ?? resolvedConfig.client.clientId,
      scope: body.data.scope ?? "whoami",
      resource: body.data.resource ?? `${resolvedConfig.baseUrl}/mcp`,
      sub: body.data.sub,
      email: body.data.email,
      name: body.data.name,
    });

    res.json({
      issuer: demoIdentityProvider.issuer,
      assertion,
      assertion_type: ID_JAG_TOKEN_TYPE,
      expires_in: 300,
    });
  });

  app.post("/token", async (req, res) => {
    const client = authenticateClient(req, resolvedConfig.client);
    if (!client) {
      res
        .status(401)
        .setHeader("WWW-Authenticate", 'Basic realm="mcp-server-id-jag"')
        .json({
          error: "invalid_client",
          error_description: "Client authentication failed",
        });
      return;
    }

    const body = TokenRequestSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: "invalid_request",
        error_description: body.error.issues.map((issue) => issue.message).join(", "),
      });
      return;
    }

    if (body.data.grant_type !== GRANT_TYPE_JWT_BEARER) {
      res.status(400).json({
        error: "unsupported_grant_type",
        error_description: "This demo only supports the JWT Bearer grant for ID-JAG exchange",
      });
      return;
    }

    try {
      const claims = await demoIdentityProvider.verifyIdJag({
        assertion: body.data.assertion,
        audience: resolvedConfig.baseUrl,
        clientId: client.clientId,
      });

      const grantedScope = claims.scope ?? "whoami";
      const accessToken = accessTokenStore.issue({
        clientId: client.clientId,
        issuer: claims.iss,
        subject: claims.sub,
        email: claims.email,
        name: claims.name,
        scope: grantedScope,
        resource: claims.resource,
      });

      res.json({
        token_type: "Bearer",
        access_token: accessToken.accessToken,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: grantedScope,
      });
    } catch (error) {
      res.status(400).json({
        error: "invalid_grant",
        error_description:
          error instanceof Error ? error.message : "The supplied assertion was rejected",
      });
    }
  });

  app.post("/mcp", async (req: AuthedRequest, res) => {
    const accessToken = accessTokenStore.read(extractBearerToken(req));
    if (!accessToken) {
      res
        .status(401)
        .setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${resolvedConfig.baseUrl}/.well-known/oauth-protected-resource"`,
        )
        .json({
          error: "invalid_token",
          error_description: "A valid Archestra-issued access token is required",
        });
      return;
    }

    req.accessToken = accessToken;

    const server = new McpServer({
      name: "id-jag-demo-server",
      version: "1.0.0",
    });

    registerTools(server, accessToken);

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

  return app;
}

export async function startServer(config: Partial<ServerConfig> = {}): Promise<void> {
  const resolvedConfig = getServerConfig(config);
  const app = await createApp(resolvedConfig);
  app.listen(resolvedConfig.port, () => {
    console.log(`MCP server listening on ${resolvedConfig.baseUrl}`);
    console.log(`OAuth metadata: ${resolvedConfig.baseUrl}/.well-known/oauth-authorization-server`);
    console.log(`Protected resource metadata: ${resolvedConfig.baseUrl}/.well-known/oauth-protected-resource`);
    console.log(`Demo client_id: ${resolvedConfig.client.clientId}`);
    console.log(`Demo client_secret: ${resolvedConfig.client.clientSecret}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}

export const TokenRequestSchema = z.object({
  grant_type: z.string(),
  assertion: z.string().min(1),
});

export const MintIdJagRequestSchema = z.object({
  client_id: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().url().optional(),
  sub: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().optional(),
});

class DemoIdentityProvider {
  public static async create(params: { baseUrl: string }): Promise<DemoIdentityProvider> {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    const keyId = crypto.randomUUID();

    return new DemoIdentityProvider({
      issuer: `${params.baseUrl}/demo-idp`,
      keyId,
      publicJwk: { ...publicJwk, kid: keyId, use: "sig", alg: "RS256" },
      privateJwk: { ...privateJwk, kid: keyId, use: "sig", alg: "RS256" },
    });
  }

  public readonly issuer: string;
  public readonly publicJwk: JWK;

  private readonly keyId: string;
  private readonly privateJwk: JWK;

  private constructor(params: {
    issuer: string;
    keyId: string;
    publicJwk: JWK;
    privateJwk: JWK;
  }) {
    this.issuer = params.issuer;
    this.keyId = params.keyId;
    this.publicJwk = params.publicJwk;
    this.privateJwk = params.privateJwk;
  }

  public async mintIdJag(claims: DemoIdJagClaims): Promise<string> {
    const privateKey = await importJWK(this.privateJwk, "RS256");

    return new SignJWT({
      client_id: claims.client_id,
      scope: claims.scope,
      resource: claims.resource,
      email: claims.email,
      name: claims.name,
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: this.keyId,
        typ: ID_JAG_JWT_TYPE,
      })
      .setIssuer(this.issuer)
      .setSubject(claims.sub)
      .setAudience(claims.resource ? [claims.resource.replace(/\/mcp$/, ""), claims.resource] : [])
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  public async verifyIdJag(params: {
    assertion: string;
    audience: string;
    clientId: string;
  }): Promise<VerifiedIdJagClaims> {
    const publicKey = await importJWK(this.publicJwk, "RS256");
    const verified = await jwtVerify(params.assertion, publicKey, {
      issuer: this.issuer,
      audience: params.audience,
    });

    if (verified.protectedHeader.typ !== ID_JAG_JWT_TYPE) {
      throw new Error(`JWT typ must be ${ID_JAG_JWT_TYPE}`);
    }

    const claims = VerifiedIdJagClaimsSchema.parse(verified.payload);
    if (claims.client_id !== params.clientId) {
      throw new Error("client_id claim does not match the authenticated client");
    }

    return claims;
  }
}

class AccessTokenStore {
  private readonly tokens = new Map<string, MintedAccessToken>();

  public issue(params: Omit<MintedAccessToken, "accessToken" | "expiresAtEpochSeconds">): MintedAccessToken {
    const accessToken: MintedAccessToken = {
      ...params,
      accessToken: crypto.randomBytes(32).toString("base64url"),
      expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    };

    this.tokens.set(accessToken.accessToken, accessToken);

    return accessToken;
  }

  public read(token: string | null): MintedAccessToken | null {
    if (!token) {
      return null;
    }

    const accessToken = this.tokens.get(token);
    if (!accessToken) {
      return null;
    }

    if (accessToken.expiresAtEpochSeconds <= Math.floor(Date.now() / 1000)) {
      this.tokens.delete(token);
      return null;
    }

    return accessToken;
  }
}

function registerTools(server: McpServer, accessToken: MintedAccessToken): void {
  server.tool("whoami", "Show the identity resolved from the exchanged ID-JAG", {}, async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              user: {
                sub: accessToken.subject,
                email: accessToken.email ?? null,
                name: accessToken.name ?? null,
              },
              accessToken: {
                clientId: accessToken.clientId,
                scope: accessToken.scope,
                resource: accessToken.resource ?? null,
                issuer: accessToken.issuer,
                expiresAtEpochSeconds: accessToken.expiresAtEpochSeconds,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  });
}

function getServerConfig(config: Partial<ServerConfig>): ServerConfig {
  const port = config.port ?? Number(process.env.PORT || DEFAULT_PORT);
  const baseUrl = config.baseUrl ?? process.env.BASE_URL ?? DEFAULT_BASE_URL;

  return {
    port,
    baseUrl,
    client: config.client ?? {
      clientId: process.env.CLIENT_ID ?? DEFAULT_CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET ?? DEFAULT_CLIENT_SECRET,
    },
  };
}

function authenticateClient(req: Request, configuredClient: DemoClient): DemoClient | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) {
    return null;
  }

  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  const clientId = decoded.slice(0, separatorIndex);
  const clientSecret = decoded.slice(separatorIndex + 1);
  if (
    clientId !== configuredClient.clientId ||
    clientSecret !== configuredClient.clientSecret
  ) {
    return null;
  }

  return configuredClient;
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  return header.slice("Bearer ".length);
}

const VerifiedIdJagClaimsSchema = z.object({
  iss: z.string().url(),
  sub: z.string(),
  aud: z.union([z.string().url(), z.array(z.string().url())]),
  exp: z.number(),
  iat: z.number(),
  jti: z.string(),
  client_id: z.string(),
  scope: z.string().optional(),
  resource: z.string().url().optional(),
  email: z.string().email().optional(),
  name: z.string().optional(),
});

type VerifiedIdJagClaims = z.infer<typeof VerifiedIdJagClaimsSchema>;
