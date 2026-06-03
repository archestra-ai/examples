# GitHub Copilot CLI with Archestra LLM Proxy

This example shows how to run GitHub Copilot CLI through Archestra's
OpenAI-compatible LLM Proxy with a virtual key.

The flow is:

```mermaid
sequenceDiagram
  participant CLI as GitHub Copilot CLI
  participant Proxy as Archestra LLM Proxy
  participant Provider as Model provider

  CLI->>Proxy: OpenAI-compatible request<br/>Authorization: Bearer virtual key
  Proxy->>Proxy: Resolve virtual key, policy, logs, cost attribution
  Proxy->>Provider: Provider request
  Provider-->>Proxy: Model response
  Proxy-->>CLI: OpenAI-compatible response
```

## Prerequisites

- Archestra running locally:
  - frontend: `http://localhost:3000`
  - backend: `http://localhost:9000`
- At least one configured LLM provider API key in Archestra.
- Node.js 20+.
- GitHub Copilot CLI:

```sh
npm install -g @github/copilot
```

## Create a Copilot env file

The setup script logs into local Archestra, creates a virtual key, and writes
Copilot's custom-provider environment variables to `.env.copilot`.

```sh
npm run setup
```

Defaults:

| Variable | Default |
| --- | --- |
| `ARCHESTRA_UI_BASE_URL` | `http://localhost:3000` |
| `ARCHESTRA_API_BASE_URL` | `http://localhost:9000` |
| `ARCHESTRA_EMAIL` | `admin@example.com` |
| `ARCHESTRA_PASSWORD` | `password` |
| `ARCHESTRA_PROVIDER` | first available provider key |
| `ARCHESTRA_MODEL` | provider key's best model, or first matching model |

Override them if needed:

```sh
ARCHESTRA_PROVIDER=azure ARCHESTRA_MODEL=gpt-4.1 npm run setup
```

## Run Copilot through Archestra

```sh
source .env.copilot

copilot -p "Reply with exactly: archestra-copilot-cli-ok" \
  --silent \
  --stream off \
  --no-color \
  --no-auto-update \
  --disable-builtin-mcps \
  --available-tools=none
```

Expected output:

```text
archestra-copilot-cli-ok
```

For an interactive coding session:

```sh
source .env.copilot
copilot
```

## Notes

- GitHub authentication is not required when Copilot CLI runs with a custom
  provider.
- The virtual key value is written once to `.env.copilot`. Treat it like a
  secret.
- Delete or rotate the virtual key in Archestra after the demo if you no longer
  need it.

