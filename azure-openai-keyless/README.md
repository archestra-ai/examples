# Azure OpenAI Keyless Example

This example calls Azure OpenAI with Microsoft Entra ID instead of an API key. It uses Azure Identity `DefaultAzureCredential`, so the same code can use Azure CLI credentials locally or managed identity in Azure-hosted environments.

## Prerequisites

- Azure CLI signed in with `az login`
- A role on the Azure OpenAI resource that can invoke deployments, such as `Cognitive Services OpenAI User`
- An Azure OpenAI deployment

## Run

1. Copy the environment file:

   ```sh
   cp .env.example .env
   ```

2. Fill in:

   ```sh
   AZURE_OPENAI_BASE_URL=https://<resource-name>.openai.azure.com/openai/deployments/<deployment-name>
   AZURE_OPENAI_API_VERSION=2024-02-01
   AZURE_OPENAI_MODEL=<deployment-name>
   ```

3. Install dependencies and run:

   ```sh
   npm install
   npm start
   ```

The script prints the model response. With the default prompt, a successful run prints `ok`.

## Archestra Configuration

Use the same deployment URL in Archestra:

```sh
ARCHESTRA_AZURE_OPENAI_BASE_URL=https://<resource-name>.openai.azure.com/openai/deployments/<deployment-name>
ARCHESTRA_AZURE_OPENAI_API_VERSION=2024-02-01
ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED=true
```

Archestra uses the Azure OpenAI token scope `https://cognitiveservices.azure.com/.default`.
