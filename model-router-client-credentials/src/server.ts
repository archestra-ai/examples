import "dotenv/config";
import express from "express";
import {
  callModelRouter,
  discoverOAuthServerMetadata,
  getAccessToken,
  requireEnv,
} from "./oauth.js";

const archestraBaseUrl =
  process.env.ARCHESTRA_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:9000";
const llmProxyId = requireEnv("LLM_PROXY_ID");
const clientId = requireEnv("OAUTH_CLIENT_ID");
const clientSecret = requireEnv("OAUTH_CLIENT_SECRET");
const model = process.env.MODEL ?? "openai:gpt-4o-mini";
const port = Number(process.env.PORT ?? 5175);

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (_request, response) => {
  return response.type("html").send(renderPage({
    body: `
      <form method="post" action="/chat">
        <label for="prompt">Prompt</label>
        <textarea id="prompt" name="prompt" rows="5">Write one sentence about service-to-service LLM proxy authentication.</textarea>
        <button type="submit">Send to Model Router</button>
      </form>
    `,
  }));
});

app.post("/chat", async (request, response, next) => {
  try {
    const metadata = await discoverOAuthServerMetadata(archestraBaseUrl);
    const token = await getAccessToken({
      tokenEndpoint: metadata.token_endpoint,
      clientId,
      clientSecret,
    });
    const completion = await callModelRouter({
      archestraBaseUrl,
      llmProxyId,
      accessToken: token.access_token,
      model,
      prompt: String(request.body.prompt ?? ""),
    });

    return response.type("html").send(renderPage({
      body: `
        <h2>Response</h2>
        <pre>${escapeHtml(completion)}</pre>
        <p><a href="/">Send another prompt</a></p>
      `,
    }));
  } catch (error) {
    next(error);
  }
});

app.listen(port, () => {
  console.log(`Client credentials example listening at http://localhost:${port}`);
});

function renderPage(params: { body: string }) {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Model Router Client Credentials Example</title>
        <style>
          body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 720px; line-height: 1.5; }
          textarea, button { font: inherit; }
          textarea { box-sizing: border-box; display: block; margin: .5rem 0 1rem; padding: .75rem; width: 100%; }
          button { background: #111827; border: 0; border-radius: 6px; color: white; display: inline-block; padding: .65rem 1rem; text-decoration: none; }
          pre { background: #f3f4f6; border-radius: 6px; overflow: auto; padding: 1rem; white-space: pre-wrap; }
        </style>
      </head>
      <body>
        <h1>Model Router Client Credentials Example</h1>
        <p>This service app exchanges its OAuth client credentials for an access token, then calls the OpenAI-compatible Model Router.</p>
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
