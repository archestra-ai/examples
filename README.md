# Archestra Examples

Example applications demonstrating how to integrate AI agents with [Archestra Platform](https://github.com/archestra-ai/archestra) for security and observability.

## Examples

- **[ai-sdk-express](./ai-sdk-express)** - Express.js app using Vercel AI SDK with Archestra security layer
- **[mastra-ai](./mastra-ai)** - Mastra framework agent with GitHub integration and docker-compose setup
- **[pydantic-ai](./pydantic-ai)** - Python agent using Pydantic AI demonstrating prompt injection protection
- **[openwebui](./openwebui)** - Open WebUI with Archestra as LLM Proxy and MCP Gateway, including Keycloak SSO
- **[openclaw](./openclaw)** - OpenClaw personal AI agent proxied through Archestra for security and observability
- **[model-router-user-oauth](./model-router-user-oauth)** - Public OAuth app that calls the OpenAI-compatible Model Router as the signed-in user
- **[model-router-client-credentials](./model-router-client-credentials)** - Service-to-service OAuth client credentials app for the OpenAI-compatible Model Router
- **[copilot-cli-llm-proxy](./copilot-cli-llm-proxy)** - GitHub Copilot CLI configured to use Archestra's OpenAI-compatible LLM Proxy
- **[mcp-gateway-entra-obo](./mcp-gateway-entra-obo)** - MCP gateway using Microsoft Entra On-Behalf-Of to exchange a user token for a downstream MCP access token
- **[mcp-server-id-jag](./mcp-server-id-jag)** - MCP server that exchanges an ID-JAG assertion for a server-specific MCP access token
- **[dummy_email_mcp_server](./dummy_email_mcp_server)** - Simple MCP server for testing email tool scenarios

## Documentation

For detailed setup instructions, see the [Archestra documentation](https://www.archestra.ai/docs).
