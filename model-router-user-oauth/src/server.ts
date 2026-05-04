import crypto from "node:crypto";
import "dotenv/config";
import express from "express";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
  scope?: string;
};

type Session = {
  state: string;
  codeVerifier: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

const archestraBaseUrl =
  process.env.ARCHESTRA_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:9000";
const appBaseUrl =
  process.env.APP_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:5174";
const port = Number(process.env.PORT ?? 5174);
const llmProxyId = process.env.LLM_PROXY_ID;
const model = process.env.MODEL ?? "openai:gpt-4o-mini";
const redirectUri = `${appBaseUrl}/oauth/callback`;

let oauthClientId = process.env.OAUTH_CLIENT_ID;
const sessions = new Map<string, Session>();

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", async (request, response) => {
  const session = getSession(request);
  if (!session?.accessToken) {
    return response.type("html").send(renderPage({
      body: `
        <p>This example signs a user into Archestra with OAuth, then calls the OpenAI-compatible Model Router with that user's access token.</p>
        <p><a class="button" href="/login">Sign in with Archestra</a></p>
      `,
    }));
  }

  return response.type("html").send(renderPage({
    body: `
      <form method="post" action="/chat">
        <label for="prompt">Prompt</label>
        <textarea id="prompt" name="prompt" rows="5">Write one sentence about secure LLM proxy authentication.</textarea>
        <button type="submit">Send to Model Router</button>
      </form>
      <p><a href="/logout">Clear local session</a></p>
    `,
  }));
});

app.get("/login", async (_request, response) => {
  oauthClientId ??= await registerPublicOAuthClient();
  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = base64Url(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );
  const sessionId = randomBase64Url(24);
  sessions.set(sessionId, { state, codeVerifier });

  const authorizeUrl = new URL("/api/auth/oauth2/authorize", archestraBaseUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", oauthClientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "llm:proxy offline_access");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  response.cookie("example_session", sessionId, {
    httpOnly: true,
    sameSite: "lax",
  });
  return response.redirect(authorizeUrl.toString());
});

app.get("/oauth/callback", async (request, response) => {
  const session = getSession(request);
  const code = getQueryString(request.query.code);
  const state = getQueryString(request.query.state);
  if (!session || !code || state !== session.state || !oauthClientId) {
    return response.status(400).send("Invalid OAuth callback.");
  }

  const token = await exchangeAuthorizationCode({
    code,
    codeVerifier: session.codeVerifier,
    clientId: oauthClientId,
  });
  session.accessToken = token.access_token;
  session.refreshToken = token.refresh_token;
  session.expiresAt = token.expires_in
    ? Date.now() + token.expires_in * 1000
    : undefined;

  return response.redirect("/");
});

app.post("/chat", async (request, response) => {
  const session = getSession(request);
  if (!session?.accessToken) {
    return response.redirect("/");
  }
  if (!llmProxyId) {
    return response.status(400).send("Set LLM_PROXY_ID in .env first.");
  }

  const prompt = String(request.body.prompt ?? "");
  const completion = await callModelRouter({
    accessToken: session.accessToken,
    prompt,
  });

  return response.type("html").send(renderPage({
    body: `
      <h2>Response</h2>
      <pre>${escapeHtml(completion)}</pre>
      <p><a href="/">Send another prompt</a></p>
    `,
  }));
});

app.get("/logout", (request, response) => {
  const sessionId = getCookie(request, "example_session");
  if (sessionId) {
    sessions.delete(sessionId);
  }
  response.clearCookie("example_session");
  return response.redirect("/");
});

app.listen(port, () => {
  console.log(`Example app listening at ${appBaseUrl}`);
});

async function registerPublicOAuthClient() {
  const registerUrl = new URL("/api/auth/oauth2/register", archestraBaseUrl);
  const response = await fetch(registerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Model Router user OAuth example",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "llm:proxy offline_access",
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.client_id) {
    throw new Error(`OAuth client registration failed: ${JSON.stringify(body)}`);
  }
  return body.client_id as string;
}

async function exchangeAuthorizationCode(params: {
  code: string;
  codeVerifier: string;
  clientId: string;
}): Promise<TokenResponse> {
  const tokenUrl = new URL("/api/auth/oauth2/token", archestraBaseUrl);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    redirect_uri: redirectUri,
    code: params.code,
    code_verifier: params.codeVerifier,
  });
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = (await response.json()) as TokenResponse;
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${JSON.stringify(token)}`);
  }
  return token;
}

async function callModelRouter(params: {
  accessToken: string;
  prompt: string;
}) {
  const response = await fetch(
    `${archestraBaseUrl}/v1/model-router/${llmProxyId}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
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

function getSession(request: express.Request) {
  const sessionId = getCookie(request, "example_session");
  return sessionId ? sessions.get(sessionId) : undefined;
}

function getCookie(request: express.Request, name: string) {
  const cookies = request.headers.cookie?.split(";") ?? [];
  const cookie = cookies
    .map((value) => value.trim().split("="))
    .find(([key]) => key === name);
  return cookie?.[1];
}

function getQueryString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function randomBase64Url(bytes: number) {
  return base64Url(crypto.randomBytes(bytes));
}

function base64Url(buffer: Buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function renderPage(params: { body: string }) {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Model Router User OAuth Example</title>
        <style>
          body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 720px; line-height: 1.5; }
          textarea, button, .button { font: inherit; }
          textarea { box-sizing: border-box; display: block; margin: .5rem 0 1rem; padding: .75rem; width: 100%; }
          button, .button { background: #111827; border: 0; border-radius: 6px; color: white; display: inline-block; padding: .65rem 1rem; text-decoration: none; }
          pre { background: #f3f4f6; border-radius: 6px; overflow: auto; padding: 1rem; white-space: pre-wrap; }
        </style>
      </head>
      <body>
        <h1>Model Router User OAuth Example</h1>
        ${params.body}
      </body>
    </html>
  `;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
