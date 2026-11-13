// Public connect service entry point. Run with: node src/connect/server.ts
//
// Binds 127.0.0.1; Caddy proxies only /connect/tiktok* to it
// (deploy/Caddyfile.chinovalley.today). Port from CVT_CONNECT_PORT.
import { serveHono } from "../admin/node-adapter.ts";
import { configFromEnv, tokenKeyFromEnv } from "../creators/tiktok-api.ts";
import { openDb } from "../db/index.ts";
import { createConnectApp } from "./app.ts";

const PORT = Number(process.env.CVT_CONNECT_PORT ?? 8789);
const HOST = "127.0.0.1";

const app = createConnectApp(openDb(), {
	cfg: configFromEnv(),
	key: tokenKeyFromEnv(),
});
const server = serveHono(app, PORT, HOST);
console.log(`connect service listening on http://${HOST}:${PORT}`);

function shutdown(): void {
	server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
