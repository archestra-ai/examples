import "dotenv/config";

type OAuthServerMetadata = {
  token_endpoint: string;
};

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  token_type: string;
  scope?: string;
};

const archestraBaseUrl =
  process.env.ARCHESTRA_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:9000";
const llmProxyId = requireEnv("LLM_PROXY_ID");
const clientId = requireEnv("OAUTH_CLIENT_ID");
const clientSecret = requireEnv("OAUTH_CLIENT_SECRET");
const model = process.env.MODEL ?? "openai:gpt-4o-mini";
const prompt =
  process.env.PROMPT ??
  "Write one sentence about service-to-service LLM proxy authentication.";

const metadata = await discoverOAuthServerMetadata();
const token = await getAccessToken(metadata.token_endpoint);
const completion = await callModelRouter(token.access_token);

console.log(completion);

async function discoverOAuthServerMetadata(): Promise<OAuthServerMetadata> {
  const response = await fetch(
    new URL("/.well-known/oauth-authorization-server", archestraBaseUrl),
  );
  const metadata = (await response.json()) as OAuthServerMetadata;
  if (!response.ok || !metadata.token_endpoint) {
    throw new Error(`OAuth metadata discovery failed: ${JSON.stringify(metadata)}`);
  }
  return metadata;
}

async function getAccessToken(tokenEndpoint: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "llm:proxy",
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = (await response.json()) as TokenResponse;
  if (!response.ok) {
    throw new Error(`Token request failed: ${JSON.stringify(token)}`);
  }
  return token;
}

async function callModelRouter(accessToken: string) {
  const response = await fetch(
    `${archestraBaseUrl}/v1/model-router/${llmProxyId}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Model Router request failed: ${JSON.stringify(body)}`);
  }
  return body.choices?.[0]?.message?.content ?? JSON.stringify(body, null, 2);
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
