import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/**
 * The shell contains no task data or credentials. Its same-origin API calls
 * use the daemon's existing scoped bearer authentication. Assets live beside
 * this module in both src/ (tsx) and dist/ (the build's copy-web step).
 */
export function registerWebQueueRoutes(app: FastifyInstance): void {
  const assets = [
    { routes: ["/queue", "/queue/"], file: "queue.html", type: "text/html; charset=utf-8" },
    { routes: ["/queue/queue.css"], file: "queue.css", type: "text/css; charset=utf-8" },
    { routes: ["/queue/queue.js"], file: "queue.js", type: "text/javascript; charset=utf-8" },
  ];

  for (const asset of assets) {
    const contents = readFileSync(new URL(`../web/${asset.file}`, import.meta.url));
    for (const url of asset.routes) {
      app.get(url, async (_request, reply) =>
        reply
          .header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
          .header("Cache-Control", "no-store")
          .header("Referrer-Policy", "no-referrer")
          .header("X-Content-Type-Options", "nosniff")
          .header("X-Frame-Options", "DENY")
          .type(asset.type)
          .send(contents),
      );
    }
  }
}
