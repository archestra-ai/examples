export type OAuthServerMetadata = {
  token_endpoint: string;
};

export type TokenResponse = {
  access_token: string;
  expires_in?: number;
  token_type: string;
  scope?: string;
};

export async function discoverOAuthServerMetadata(
  archestraBaseUrl: string,
): Promise<OAuthServerMetadata> {
  const response = await fetch(
    new URL("/.well-known/oauth-authorization-server", archestraBaseUrl),
  );
  const metadata = (await response.json()) as OAuthServerMetadata;
  if (!response.ok || !metadata.token_endpoint) {
    throw new Error(
      `OAuth metadata discovery failed: ${JSON.stringify(metadata)}`,
    );
  }
  return metadata;
}

export async function getAccessToken(params: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    scope: "llm:proxy",
  });

  const response = await fetch(params.tokenEndpoint, {
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

export async function callModelRouter(params: {
  archestraBaseUrl: string;
  llmProxyId: string;
  accessToken: string;
  model: string;
  prompt: string;
}) {
  const response = await fetch(
    `${params.archestraBaseUrl}/v1/model-router/${params.llmProxyId}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: params.model,
        messages: [{ role: "user", content: params.prompt }],
      }),
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Model Router request failed: ${JSON.stringify(body)}`);
  }
  return body.choices?.[0]?.message?.content ?? JSON.stringify(body, null, 2);
}

export function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
