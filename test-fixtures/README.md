# E2E Test Fixtures

Standalone MCP servers used as fixtures by the [Archestra Platform](https://github.com/archestra-ai/archestra) end-to-end test suite.

These are **internal test fixtures**, not tutorial examples. They were extracted from the platform repository (`platform/e2e-tests/test-mcp-servers/`) and live here so their (npm) dependency surface no longer generates Dependabot traffic in the more security-sensitive platform repo. The platform e2e tests do **not** build these from source — they pull the pre-built, pinned images from Google Artifact Registry.

## Servers

| Directory | Purpose | Image | Used by e2e |
| --- | --- | --- | --- |
| `mcp-example-oauth-server` | OAuth 2.1 fixture server (clones the upstream MCP example remote server) | `…/archestra-public/mcp-example-oauth-server:0.0.1` | yes |
| `mcp-server-jwks-keycloak` | Protected server for JWT propagation + enterprise-managed credential exchange tests | `…/archestra-public/mcp-server-jwks-keycloak:0.0.3` | yes |
| `mcp-server-id-jag` | Protected server whose authorization server accepts ID-JAG assertions and mints MCP-server access tokens | `…/archestra-public/mcp-server-id-jag:0.0.4` | yes |
| `mcp-server-network-probe` | Network-probe MCP server for manual local network-policy testing | `…/archestra-public/mcp-server-network-probe:0.0.1` | no (manual/local only) |
| `mcp-server-entra-obo-debug` | Debug server that echoes received bearer-token metadata, for verifying Entra OBO credentials | _(never containerized — `npm start` locally)_ | no (manual/local only) |

Registry prefix: `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public`

## Building and publishing images

Images are built and pushed **manually** (there is no CI workflow). The pinned tag for each server lives in its `Makefile`. To publish a new image after changing a server, bump the tag in the `Makefile`, then:

```bash
cd mcp-server-id-jag        # or any other server directory
gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet
make publish                # or `make push`, see each Makefile
```

After pushing a new tag, update the corresponding reference in the platform repo:

- `platform/e2e-tests/consts.ts` (e.g. `MCP_SERVER_JWKS_DOCKER_IMAGE`)
- `platform/.github/actions/setup-archestra-platform/action.yml` (the hardcoded image versions the e2e setup pulls)
- `platform/helm/e2e-tests/values.yaml` (image repository/tag)

`mcp-server-entra-obo-debug` has no Dockerfile; run it locally with `npm install && npm start`.
