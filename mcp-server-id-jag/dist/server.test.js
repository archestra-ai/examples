import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createApp } from "./server.js";
test("exchanges an ID-JAG for an access token and exposes whoami", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
        const mintResponse = await fetch(`${baseUrl}/demo-idp/mint`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                sub: "user-123",
                email: "alice@example.com",
                name: "Alice Example",
            }),
        });
        assert.equal(mintResponse.status, 200);
        const mintedBody = (await mintResponse.json());
        const tokenResponse = await fetch(`${baseUrl}/token`, {
            method: "POST",
            headers: {
                authorization: basicAuth("demo-client", "demo-secret"),
                "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion: mintedBody.assertion,
            }),
        });
        assert.equal(tokenResponse.status, 200);
        const tokenBody = (await tokenResponse.json());
        const mcpResponse = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${tokenBody.access_token}`,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                    name: "whoami",
                    arguments: {},
                },
            }),
        });
        assert.equal(mcpResponse.status, 200);
        const rpcBody = parseSseJsonResponse(await mcpResponse.text());
        const whoami = JSON.parse(rpcBody.result.content[0].text);
        assert.equal(whoami.user.sub, "user-123");
        assert.equal(whoami.user.email, "alice@example.com");
        assert.equal(whoami.user.name, "Alice Example");
    }
    finally {
        await close();
    }
});
test("rejects an ID-JAG when the authenticated client does not match the claim", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
        const mintResponse = await fetch(`${baseUrl}/demo-idp/mint`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                sub: "user-456",
                client_id: "different-client",
            }),
        });
        assert.equal(mintResponse.status, 200);
        const mintedBody = (await mintResponse.json());
        const tokenResponse = await fetch(`${baseUrl}/token`, {
            method: "POST",
            headers: {
                authorization: basicAuth("demo-client", "demo-secret"),
                "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion: mintedBody.assertion,
            }),
        });
        assert.equal(tokenResponse.status, 400);
        const body = (await tokenResponse.json());
        assert.equal(body.error, "invalid_grant");
    }
    finally {
        await close();
    }
});
async function startTestServer() {
    const port = await getAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const app = await createApp({ baseUrl, port });
    const server = http.createServer(app);
    await new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => resolve());
    });
    return {
        baseUrl,
        close: async () => {
            await new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        },
    };
}
function parseSseJsonResponse(body) {
    const dataLine = body
        .split("\n")
        .find((line) => line.startsWith("data: "));
    if (!dataLine) {
        throw new Error(`No SSE data payload found in response: ${body}`);
    }
    return JSON.parse(dataLine.slice("data: ".length));
}
function basicAuth(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
async function getAvailablePort() {
    return await new Promise((resolve, reject) => {
        const server = http.createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("Failed to allocate test port"));
                return;
            }
            const port = address.port;
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(port);
            });
        });
    });
}
