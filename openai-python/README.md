# OpenAI Python SDK + Archestra

A minimal Python chat app showing how to route OpenAI requests through the
[Archestra LLM Proxy](https://archestra.ai) for security guardrails,
observability, and policy enforcement — with zero changes to your existing
OpenAI SDK code beyond the `base_url`.

## How it works

```
Your app  →  Archestra LLM Proxy  →  OpenAI API
              (security policies,
               usage logs, rate limits)
```

The only change from a standard OpenAI integration is setting `base_url` to
your Archestra proxy URL. The SDK, models, and API surface stay identical.

## Prerequisites

- Python 3.9+
- An Archestra instance running locally (`http://localhost:9000`) or in the cloud
- An OpenAI API key

## Setup

```bash
# 1. Copy the env template and fill in your values
cp .env.example .env

# 2. Install dependencies
pip install -r requirements.txt

# 3. Run the interactive chat
python main.py
```

## Configuration

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI API key |
| `ARCHESTRA_PROXY_URL` | Archestra proxy URL (from LLM Proxy → Connect in the UI) |

## Using a different model

Change the `model` parameter in `main.py`:

```python
response = client.chat.completions.create(
    model="gpt-4o-mini",   # or any model available in your Archestra setup
    messages=history,
)
```
