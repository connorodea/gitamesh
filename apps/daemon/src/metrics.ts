import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";

/**
 * In-process counters for the things that are cheap to increment at the
 * point of occurrence but not cheap (or not meaningful) to derive from a
 * `SELECT` — websocket client count, lease-expiration count, claim
 * conflicts. Task counts by state ARE derived on demand from storage
 * (`countTasksByStatus`) since that's a trivial grouped count.
 */
export class Metrics {
  leaseExpirations = 0;
  claimConflicts = 0;
  private wsClients = 0;

  incrementLeaseExpirations(n: number): void {
    this.leaseExpirations += n;
  }

  incrementClaimConflicts(): void {
    this.claimConflicts += 1;
  }

  wsClientConnected(): void {
    this.wsClients += 1;
  }

  wsClientDisconnected(): void {
    this.wsClients = Math.max(0, this.wsClients - 1);
  }

  get wsClientCount(): number {
    return this.wsClients;
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Renders Prometheus text exposition format. Hand-rolled — no metrics library needed for this small a surface. */
export function renderPrometheus(storage: SqliteStorageAdapter, metrics: Metrics): string {
  const lines: string[] = [];

  lines.push("# HELP gitamesh_tasks_total Number of tasks currently in each state.");
  lines.push("# TYPE gitamesh_tasks_total gauge");
  const byStatus = storage.countTasksByStatus();
  for (const [status, count] of Object.entries(byStatus)) {
    lines.push(`gitamesh_tasks_total{status="${escapeLabel(status)}"} ${count}`);
  }
  if (Object.keys(byStatus).length === 0) {
    // Emit nothing extra; an empty gauge family with only HELP/TYPE lines
    // is valid Prometheus exposition format.
  }

  lines.push("# HELP gitamesh_lease_expirations_total Total attempts whose lease expired and were reclaimed.");
  lines.push("# TYPE gitamesh_lease_expirations_total counter");
  lines.push(`gitamesh_lease_expirations_total ${metrics.leaseExpirations}`);

  lines.push("# HELP gitamesh_claim_conflicts_total Total task/resource claim attempts rejected due to a conflict.");
  lines.push("# TYPE gitamesh_claim_conflicts_total counter");
  lines.push(`gitamesh_claim_conflicts_total ${metrics.claimConflicts}`);

  lines.push("# HELP gitamesh_websocket_clients_connected Currently connected /v1/events/stream WebSocket clients.");
  lines.push("# TYPE gitamesh_websocket_clients_connected gauge");
  lines.push(`gitamesh_websocket_clients_connected ${metrics.wsClientCount}`);

  return lines.join("\n") + "\n";
}
