import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken, type Scope } from "../src/auth.js";

let storage: SqliteStorageAdapter;
let built: BuiltServer;

beforeEach(() => {
  storage = createInMemorySqliteStorage();
  built = buildServer({ storage, logger: false });
});

afterEach(async () => {
  await built.app.close();
  storage.close();
});

function auth(scopes: Scope[]) {
  return { authorization: `Bearer ${mintToken(storage, scopes).rawToken}` };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  hostname: "worker-01.example.com",
  display_name: "Worker 1",
  agent_id: "agent_1",
  capabilities: ["gpu"],
  metadata: {},
  ...overrides,
});

function register(payload: Record<string, unknown>, scopes: Scope[] = ["device:register"]) {
  return built.app.inject({ method: "POST", url: "/v1/devices", headers: auth(scopes), payload });
}

function list(scopes: Scope[] = ["agent:read"]) {
  return built.app.inject({ method: "GET", url: "/v1/devices", headers: auth(scopes) });
}

function get(deviceId: string, scopes: Scope[] = ["agent:read"]) {
  return built.app.inject({ method: "GET", url: `/v1/devices/${deviceId}`, headers: auth(scopes) });
}

function heartbeat(deviceId: string, scopes: Scope[] = ["device:heartbeat"]) {
  return built.app.inject({ method: "POST", url: `/v1/devices/${deviceId}/heartbeat`, headers: auth(scopes) });
}

describe("POST /v1/devices", () => {
  it("registers a device and returns 201", async () => {
    const res = await register(body({ namespace_id: "team-a" }));

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(
      expect.objectContaining({
        device_id: expect.stringMatching(/^device_/),
        namespace_id: "team-a",
        hostname: "worker-01.example.com",
        display_name: "Worker 1",
        status: "registered",
        agent_id: "agent_1",
        capabilities: ["gpu"],
      }),
    );
  });

  it("defaults namespace_id to 'default'", async () => {
    const res = await register({
      hostname: "worker-02",
      display_name: "Worker 2",
      agent_id: "agent_2",
      capabilities: [],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().namespace_id).toBe("default");
  });

  it("emits a device.registered event", async () => {
    await register(body({ agent_id: "agent_1" }));

    const events = storage.listAllEvents().filter((e) => e.event_type === "device.registered");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      namespace_id: "default",
      agent_id: "agent_1",
      payload: expect.objectContaining({
        hostname: "worker-01.example.com",
        capabilities: ["gpu"],
      }),
    });
  });
});

describe("GET /v1/devices/:deviceId", () => {
  it("returns a registered device", async () => {
    const registered = await register(body());
    const deviceId = registered.json().device_id;

    const res = await get(deviceId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(registered.json());
  });

  it("returns 404 for a nonexistent device", async () => {
    const res = await get("device_nonexistent");

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: expect.stringContaining("not-found"),
      title: "Device Not Found",
    });
  });
});

describe("GET /v1/devices", () => {
  it("returns an empty list when no devices exist", async () => {
    const res = await list();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ devices: [] });
  });

  it("returns all registered devices", async () => {
    await register(body({ agent_id: "agent_1" }));
    await register(body({ agent_id: "agent_2", hostname: "worker-02" }));

    const res = await list();

    expect(res.statusCode).toBe(200);
    expect(res.json().devices).toHaveLength(2);
    expect(res.json().devices[0].agent_id).toBe("agent_1");
    expect(res.json().devices[1].agent_id).toBe("agent_2");
  });
});

describe("POST /v1/devices/:deviceId/heartbeat", () => {
  it("updates device status to online and sets last_heartbeat_at", async () => {
    const registered = await register(body());
    const deviceId = registered.json().device_id;
    const beforeHeartbeat = registered.json();
    expect(beforeHeartbeat.status).toBe("registered");
    expect(beforeHeartbeat.last_heartbeat_at).toBeNull();

    const heartbeatRes = await heartbeat(deviceId);

    expect(heartbeatRes.statusCode).toBe(200);
    const updated = heartbeatRes.json();
    expect(updated.status).toBe("online");
    expect(updated.last_heartbeat_at).toBeTruthy();
  });

  it("returns 404 for a nonexistent device", async () => {
    const res = await heartbeat("device_nonexistent");

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: expect.stringContaining("not-found"),
      title: "Device Not Found",
    });
  });

  it("emits a device.heartbeat event", async () => {
    const registered = await register(body());
    const deviceId = registered.json().device_id;

    await heartbeat(deviceId);

    const events = storage.listAllEvents().filter((e) => e.event_type === "device.heartbeat");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent_id: "agent_1",
      namespace_id: "default",
    });
  });
});
