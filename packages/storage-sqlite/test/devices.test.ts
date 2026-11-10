import { describe, it, expect, beforeEach } from "vitest";
import { createInMemorySqliteStorage } from "../src/index.js";
import type { Device } from "@gitamesh/protocol";

describe("Device storage", () => {
  let storage = createInMemorySqliteStorage();

  beforeEach(() => {
    storage.close();
    storage = createInMemorySqliteStorage();
  });

  describe("saveDevice and getDevice", () => {
    it("saves and retrieves a device", () => {
      const now = storage.now();
      const device: Device = {
        device_id: "device_1",
        namespace_id: "ns_1",
        hostname: "worker-01.example.com",
        display_name: "Worker 1",
        capabilities: ["gpu", "cuda:11.8"],
        status: "online",
        agent_id: "agent_1",
        last_heartbeat_at: now,
        created_at: now,
        metadata: { region: "us-east-1" },
      };

      storage.saveDevice(device);
      const retrieved = storage.getDevice("device_1");

      expect(retrieved).toEqual(device);
    });

    it("updates an existing device on save", () => {
      const now = storage.now();
      const device: Device = {
        device_id: "device_1",
        namespace_id: "ns_1",
        hostname: "worker-01.example.com",
        display_name: "Worker 1",
        capabilities: ["gpu"],
        status: "online",
        agent_id: "agent_1",
        last_heartbeat_at: now,
        created_at: now,
        metadata: {},
      };

      storage.saveDevice(device);

      const updated: Device = {
        ...device,
        status: "offline",
        capabilities: ["gpu", "cuda:12.0"],
      };

      storage.saveDevice(updated);
      const retrieved = storage.getDevice("device_1");

      expect(retrieved?.status).toBe("offline");
      expect(retrieved?.capabilities).toContain("cuda:12.0");
    });

    it("returns undefined for a nonexistent device", () => {
      const retrieved = storage.getDevice("nonexistent");
      expect(retrieved).toBeUndefined();
    });
  });

  describe("listDevices", () => {
    it("returns an empty list when no devices exist", () => {
      const devices = storage.listDevices();
      expect(devices).toEqual([]);
    });

    it("returns all saved devices in order", () => {
      const now = storage.now();
      const device1: Device = {
        device_id: "device_1",
        namespace_id: "ns_1",
        hostname: "worker-01",
        display_name: "Worker 1",
        capabilities: [],
        status: "online",
        agent_id: "agent_1",
        last_heartbeat_at: now,
        created_at: now,
        metadata: {},
      };

      const device2: Device = {
        device_id: "device_2",
        namespace_id: "ns_1",
        hostname: "worker-02",
        display_name: "Worker 2",
        capabilities: ["gpu"],
        status: "offline",
        agent_id: "agent_2",
        last_heartbeat_at: null,
        created_at: now,
        metadata: {},
      };

      storage.saveDevice(device1);
      storage.saveDevice(device2);

      const devices = storage.listDevices();
      expect(devices).toHaveLength(2);
      expect(devices[0].device_id).toBe("device_1");
      expect(devices[1].device_id).toBe("device_2");
    });
  });

  describe("listDevicesWithCapability", () => {
    it("returns devices with a specific capability", () => {
      const now = storage.now();

      storage.saveDevice({
        device_id: "device_1",
        namespace_id: "ns_1",
        hostname: "gpu-worker",
        display_name: "GPU Worker",
        capabilities: ["gpu", "cuda:11.8"],
        status: "online",
        agent_id: "agent_1",
        last_heartbeat_at: now,
        created_at: now,
        metadata: {},
      });

      storage.saveDevice({
        device_id: "device_2",
        namespace_id: "ns_1",
        hostname: "cpu-worker",
        display_name: "CPU Worker",
        capabilities: ["cpu"],
        status: "online",
        agent_id: "agent_2",
        last_heartbeat_at: now,
        created_at: now,
        metadata: {},
      });

      storage.saveDevice({
        device_id: "device_3",
        namespace_id: "ns_1",
        hostname: "gpu-worker-2",
        display_name: "GPU Worker 2",
        capabilities: ["gpu", "cuda:12.0"],
        status: "offline",
        agent_id: "agent_3",
        last_heartbeat_at: null,
        created_at: now,
        metadata: {},
      });

      const gpuDevices = storage.listDevicesWithCapability("gpu");
      expect(gpuDevices).toHaveLength(2);
      expect(gpuDevices.map((d) => d.device_id)).toContain("device_1");
      expect(gpuDevices.map((d) => d.device_id)).toContain("device_3");
    });

    it("returns empty list when no devices have a capability", () => {
      const now = storage.now();
      storage.saveDevice({
        device_id: "device_1",
        namespace_id: "ns_1",
        hostname: "worker",
        display_name: "Worker",
        capabilities: ["cpu"],
        status: "online",
        agent_id: "agent_1",
        last_heartbeat_at: now,
        created_at: now,
        metadata: {},
      });

      const devices = storage.listDevicesWithCapability("gpu");
      expect(devices).toEqual([]);
    });
  });
});
