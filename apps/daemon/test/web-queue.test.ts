import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWebQueueRoutes } from "../src/routes/web-queue.js";

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
  registerWebQueueRoutes(app);
});

afterEach(async () => { await app.close(); });

describe("web task queue", () => {
  it("serves the shell and all referenced assets without authentication or external resources", async () => {
    const page = await app.inject("/queue");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Task queue");
    expect(page.body).toContain('type="password"');
    const resources = [...page.body.matchAll(/(?:src|href)="(\/queue\/[^\"]+)"/g)].map((match) => match[1]!);
    expect(resources).toHaveLength(2);
    for (const url of resources) {
      const asset = await app.inject(url);
      expect(asset.statusCode).toBe(200);
      expect(asset.body.length).toBeGreaterThan(100);
      expect(asset.headers["content-type"]).toContain(url.endsWith(".css") ? "text/css" : "text/javascript");
    }
    expect(page.body).not.toMatch(/(?:src|href)="https?:/);
    expect((await app.inject("/queue/")).body).toBe(page.body);
  });

  it("applies a restrictive CSP and prevents caching, framing, and content sniffing", async () => {
    for (const url of ["/queue", "/queue/queue.css", "/queue/queue.js"]) {
      const response = await app.inject(url);
      const csp = response.headers["content-security-policy"] as string;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("never reflects credentials supplied in a request into the public shell", async () => {
    const marker = "gm_this_is_a_private_test_credential";
    const response = await app.inject({
      method: "GET", url: `/queue?token=${marker}`,
      headers: { authorization: `Bearer ${marker}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(marker);
    expect(Object.values(response.headers).join(" ")).not.toContain(marker);
    expect(response.body).toBe((await app.inject("/queue")).body);
  });

  it("serves only the fixed public assets, never arbitrary daemon files", async () => {
    for (const url of ["/queue/auth.ts", "/queue/../auth.ts", "/queue/%2e%2e/auth.ts", "/queue/package.json"]) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(404);
    }
  });
});
