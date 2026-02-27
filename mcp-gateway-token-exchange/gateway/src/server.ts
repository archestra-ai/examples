import express from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();

// Use raw body passthrough for proxying — we parse JSON ourselves only for auth
app.use(express.json());

// ── Configuration ──────────────────────────────────────────────────────
const JWKS_URL = process.env.JWKS_URL!;
const JWT_ISSUER = process.env.JWT_ISSUER!;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "mcp-server";
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3456";
const KEYCLOAK_ISSUER_URL =
  process.env.KEYCLOAK_ISSUER_URL || "http://localhost:8080/realms/mcp-demo";
const UPSTREAM_MCP_URL =
  process.env.UPSTREAM_MCP_URL || "http://mock-github-mcp:3457/mcp";

// Token map: Keycloak email -> service-specific token
// In production this would come from:
//   - Keycloak token exchange (RFC 8693)
//   - A secrets vault (HashiCorp Vault, AWS Secrets Manager)
//   - Archestra's per-user credential store
const TOKEN_MAP: Record<string, string> = JSON.parse(
  process.env.TOKEN_MAP || "{}",
);

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

// ── JWT Validation ─────────────────────────────────────────────────────
interface AuthContext {
  sub: string;
  email?: string;
  name?: string;
  roles: string[];
}

async function verifyKeycloakJwt(token: string): Promise<AuthContext> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    clockTolerance: 30,
  });

  return {
    sub: payload.sub!,
    email: payload.email as string | undefined,
    name: payload.name as string | undefined,
    roles: (payload.realm_roles as string[]) || [],
  };
}

// ── RFC 9728: Protected Resource Metadata ──────────────────────────────
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: GATEWAY_URL,
    authorization_servers: [KEYCLOAK_ISSUER_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: [],
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Token Exchange + MCP Proxy ─────────────────────────────────────────
app.post("/mcp", async (req, res) => {
  // Step 1: Extract and validate the Keycloak JWT
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${GATEWAY_URL}/.well-known/oauth-protected-resource"`,
      )
      .json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const keycloakJwt = authHeader.slice(7);
  let auth: AuthContext;

  try {
    auth = await verifyKeycloakJwt(keycloakJwt);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Token verification failed";
    res.status(401).json({ error: "Invalid Keycloak JWT", details: message });
    return;
  }

  // Step 2: Token Exchange — swap the Keycloak identity for a service-specific token
  const email = auth.email;
  if (!email) {
    res.status(403).json({
      error: "No email claim in JWT — cannot resolve service credentials",
    });
    return;
  }

  const githubToken = TOKEN_MAP[email];
  if (!githubToken) {
    res.status(403).json({
      error: `No GitHub credentials configured for ${email}`,
      hint: "An admin needs to provision a GitHub token for this user",
    });
    return;
  }

  console.log(
    `[token-exchange] ${email} (${auth.name}) → swapping Keycloak JWT for GitHub token`,
  );

  // Step 3: Proxy the MCP request to the upstream server with the swapped token
  try {
    const upstreamResponse = await fetch(UPSTREAM_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: req.headers.accept || "application/json, text/event-stream",
        // The key part: send the GitHub token, NOT the Keycloak JWT
        Authorization: `Bearer ${githubToken}`,
      },
      body: JSON.stringify(req.body),
    });

    // Forward the upstream response back to the client
    res.status(upstreamResponse.status);

    // Copy relevant headers
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) {
      res.set("Content-Type", contentType);
    }

    const body = await upstreamResponse.text();
    res.send(body);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Upstream request failed";
    console.error(`[proxy] Error forwarding to upstream: ${message}`);
    res.status(502).json({ error: "Failed to reach upstream MCP server" });
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed" });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed" });
});

// ── Start ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3456;
app.listen(PORT, () => {
  console.log(
    `Token Exchange Gateway listening on http://localhost:${PORT}`,
  );
  console.log(`JWKS URL: ${JWKS_URL}`);
  console.log(`JWT Issuer: ${JWT_ISSUER}`);
  console.log(`JWT Audience: ${JWT_AUDIENCE}`);
  console.log(`Upstream MCP: ${UPSTREAM_MCP_URL}`);
  console.log(
    `Token map entries: ${Object.keys(TOKEN_MAP).join(", ") || "(empty)"}`,
  );
});
