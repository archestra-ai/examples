# Model Router Client Credentials Example

This example uses an Archestra LLM OAuth client to call the OpenAI-compatible Model Router with OAuth client credentials.

Use this pattern for backend services, automation jobs, bots, and server-side applications that should authenticate as an app rather than as an individual user.

## Prerequisites

- Archestra running locally
- An LLM Proxy ID
- A Model Provider key configured in Archestra
- An OAuth client created in **LLM Proxies > Proxy Auth > OAuth Clients**

When creating the OAuth client, select the LLM proxy it can access and map at least one provider API key. The Model Router can only route to providers mapped on the OAuth client.

## Run

1. Copy the environment file:

   ```sh
   cp .env.example .env
   ```

2. Fill in:

   ```sh
   LLM_PROXY_ID=<your LLM proxy id>
   OAUTH_CLIENT_ID=<client id from Proxy Auth>
   OAUTH_CLIENT_SECRET=<one-time client secret from Proxy Auth>
   MODEL=openai:gpt-4o-mini
   ```

3. Install dependencies and run the CLI:

   ```sh
   npm install
   npm start
   ```

   Or start the browser demo:

   ```sh
   npm run dev
   ```

   Then open <http://localhost:5175>.

## How it works

1. The app discovers Archestra's OAuth token endpoint from `/.well-known/oauth-authorization-server`.
2. The app exchanges `client_id` and `client_secret` for an access token:

   ```text
   grant_type=client_credentials
   scope=llm:proxy
   ```

3. The app calls `/v1/model-router/{LLM_PROXY_ID}/chat/completions` with `Authorization: Bearer <access token>`.

OAuth client credentials are separate from user OAuth. They do not show a consent screen and do not inherit a user's provider keys. Provider key access comes from the OAuth client configuration in **Proxy Auth**.
