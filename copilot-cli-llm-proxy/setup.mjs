import { writeFile } from "node:fs/promises";

const config = {
  uiBaseUrl: env("ARCHESTRA_UI_BASE_URL", "http://localhost:3000"),
  apiBaseUrl: env("ARCHESTRA_API_BASE_URL", "http://localhost:9000"),
  email: env("ARCHESTRA_EMAIL", "admin@example.com"),
  password: env("ARCHESTRA_PASSWORD", "password"),
  provider: process.env.ARCHESTRA_PROVIDER,
  model: process.env.ARCHESTRA_MODEL,
};

let cookie = "";

await login();

const providerKey = await selectProviderKey();
const llmProxy = await selectDefaultLlmProxy();
const model = await selectModel(providerKey);
const virtualKey = await createVirtualKey(providerKey);

const envFile = [
  "export COPILOT_PROVIDER_TYPE=openai",
  `export COPILOT_PROVIDER_BASE_URL=${quote(`${config.apiBaseUrl}/v1/${providerKey.provider}/${llmProxy.id}`)}`,
  `export COPILOT_PROVIDER_API_KEY=${quote(virtualKey.value)}`,
  `export COPILOT_MODEL=${quote(model.modelId)}`,
  `export COPILOT_PROVIDER_MODEL_ID=${quote(model.modelId)}`,
  `export COPILOT_PROVIDER_WIRE_MODEL=${quote(model.modelId)}`,
  `export ARCHESTRA_COPILOT_VIRTUAL_KEY_ID=${quote(virtualKey.id)}`,
  "",
].join("\n");

await writeFile(".env.copilot", envFile, { mode: 0o600 });

console.log("Wrote .env.copilot");
console.log(
  JSON.stringify(
    {
      provider: providerKey.provider,
      providerApiKeyName: providerKey.name,
      llmProxyName: llmProxy.name,
      llmProxyId: llmProxy.id,
      model: model.modelId,
      virtualKeyId: virtualKey.id,
      tokenStart: virtualKey.tokenStart,
    },
    null,
    2,
  ),
);

async function login() {
  const response = await fetch(
    `${config.uiBaseUrl}/api/auth/sign-in/email`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: config.uiBaseUrl,
      },
      body: JSON.stringify({
        email: config.email,
        password: config.password,
      }),
    },
  );
  captureCookies(response);
  await requireOk(response, "sign in to Archestra");
}

async function selectProviderKey() {
  const keys = await requestJson("/api/llm-provider-api-keys/available");
  const preferredProviders = [
    "openai",
    "azure",
    "openrouter",
    "vllm",
    "ollama",
    "groq",
    "mistral",
    "deepseek",
    "xai",
    "cerebras",
  ];

  const key = config.provider
    ? keys.find((item) => item.provider === config.provider)
    : preferredProviders
        .map((provider) => keys.find((item) => item.provider === provider))
        .find(Boolean) ?? keys[0];
  if (!key) {
    throw new Error(
      config.provider
        ? `No available provider key found for ${config.provider}`
        : "No available provider keys found in Archestra",
    );
  }
  return key;
}

async function selectDefaultLlmProxy() {
  const response = await requestJson("/api/agents?agentType=llm_proxy&limit=100");
  const proxy = response.data?.find((item) => item.isDefault) ?? response.data?.[0];
  if (!proxy) {
    throw new Error("No LLM Proxy found in Archestra");
  }
  return proxy;
}

async function selectModel(providerKey) {
  if (config.model) {
    return { modelId: config.model };
  }

  const models = await requestJson("/api/llm-models?limit=200");

  if (providerKey.bestModelId) {
    const bestModel = models.find((item) => item.id === providerKey.bestModelId);
    if (bestModel) {
      return bestModel;
    }
  }

  const model = models.find((item) => item.provider === providerKey.provider);
  if (!model) {
    throw new Error(`No model found for provider ${providerKey.provider}`);
  }
  return model;
}

async function createVirtualKey(providerKey) {
  return requestJson("/api/llm-virtual-keys", {
    method: "POST",
    body: JSON.stringify({
      name: `copilot-cli-${new Date().toISOString()}`,
      scope: "org",
      teams: [],
      providerApiKeys: [
        {
          provider: providerKey.provider,
          providerApiKeyId: providerKey.id,
        },
      ],
    }),
  });
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${config.uiBaseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Origin: config.uiBaseUrl,
      Cookie: cookie,
      ...(options.headers ?? {}),
    },
  });
  captureCookies(response);
  await requireOk(response, path);
  return response.json();
}

async function requireOk(response, action) {
  if (response.ok) {
    return;
  }
  throw new Error(`Failed to ${action}: ${response.status} ${await response.text()}`);
}

function captureCookies(response) {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) {
    return;
  }
  cookie = setCookies.map((value) => value.split(";")[0]).join("; ");
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
