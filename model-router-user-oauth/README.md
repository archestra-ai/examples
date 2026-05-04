# Model Router User OAuth Example

This example is a small public OAuth application that signs a user into Archestra, receives an OAuth access token with the `llm:proxy` scope, and calls the OpenAI-compatible Model Router with that user's token.

Use this pattern when your application should call an LLM proxy as the signed-in user. The Model Router resolves provider keys from the user's accessible Model Provider keys: personal keys, organization keys, and team keys for teams the user belongs to.

## Prerequisites

- Archestra running locally
- A Model Provider key configured in Archestra for the provider you want to call
- An LLM Proxy ID
- A Model Router model id such as `openai:gpt-4o-mini`

## Run

1. Copy the environment file:

   ```sh
   cp .env.example .env
   ```

2. Set `LLM_PROXY_ID` in `.env`.

3. Install dependencies and start the app:

   ```sh
   npm install
   npm run dev
   ```

4. Open <http://localhost:5174>.

5. Click **Sign in with Archestra**, approve the OAuth consent screen, then send a prompt.

## How it works

1. The app dynamically registers a public OAuth client at `/api/auth/oauth2/register`.
2. The app redirects the user to `/api/auth/oauth2/authorize` with `scope=llm:proxy offline_access` and PKCE parameters.
3. Archestra shows the consent screen.
4. The app exchanges the authorization code at `/api/auth/oauth2/token`.
5. The app calls `/v1/model-router/{LLM_PROXY_ID}/chat/completions` with `Authorization: Bearer <access token>`.

The OAuth client in this example is a public authorization-code client. It is separate from **LLM Proxies > Proxy Auth > OAuth Clients**, which creates confidential clients for the `client_credentials` flow.
