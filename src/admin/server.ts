// Admin dashboard entry point. Run with: node src/admin/server.ts
//
// Binds 127.0.0.1 ONLY — this is meant to sit behind Caddy basic auth in a
// later phase and must never be exposed directly. Port from
// CVT_ADMIN_PORT, default 8787.
import { openDb } from "../db/index.ts";
import { createApp } from "./app.ts";
import { serveHono } from "./node-adapter.ts";

const PORT = Number(process.env.CVT_ADMIN_PORT ?? 8787);
const HOST = "127.0.0.1";

const db = openDb();
const app = createApp(db);
const server = serveHono(app, PORT, HOST);

console.log(`admin dashboard listening on http://${HOST}:${PORT}`);

function shutdown(): void {
	server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
