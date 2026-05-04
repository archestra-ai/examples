import "dotenv/config";
import {
  callModelRouter,
  discoverOAuthServerMetadata as discoverMetadata,
  getAccessToken,
  requireEnv,
} from "./oauth.js";

const archestraBaseUrl =
  process.env.ARCHESTRA_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:9000";
const llmProxyId = requireEnv("LLM_PROXY_ID");
const clientId = requireEnv("OAUTH_CLIENT_ID");
const clientSecret = requireEnv("OAUTH_CLIENT_SECRET");
const model = process.env.MODEL ?? "openai:gpt-4o-mini";
const prompt =
  process.env.PROMPT ??
  "Write one sentence about service-to-service LLM proxy authentication.";

const metadata = await discoverMetadata(archestraBaseUrl);
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
  prompt,
});

console.log(completion);
