import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import "dotenv/config";
import OpenAI from "openai";

const baseURL = requiredEnv("AZURE_OPENAI_BASE_URL");
const model = process.env.AZURE_OPENAI_MODEL ?? getDeploymentName(baseURL);
const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-02-01";

const tokenProvider = getBearerTokenProvider(
  new DefaultAzureCredential(),
  "https://cognitiveservices.azure.com/.default",
);

const client = new OpenAI({
  apiKey: tokenProvider,
  baseURL,
  defaultQuery: { "api-version": apiVersion },
});

const response = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "Reply with only: ok" }],
  max_tokens: 8,
});

console.log(response.choices[0]?.message?.content ?? "");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getDeploymentName(urlValue) {
  const url = new URL(urlValue);
  const parts = url.pathname.split("/").filter(Boolean);
  const deploymentIndex = parts.indexOf("deployments");
  if (deploymentIndex === -1 || !parts[deploymentIndex + 1]) {
    throw new Error(
      "AZURE_OPENAI_MODEL is required when AZURE_OPENAI_BASE_URL does not include /deployments/<deployment-name>",
    );
  }
  return parts[deploymentIndex + 1];
}
