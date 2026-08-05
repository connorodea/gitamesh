import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import { handleListClaims, ListClaimsInputSchema, ListClaimsOutputSchema } from "../../src/tools/list-claims.js";
import { createFakeFetch } from "../support/fake-fetch.js";
import { fakeClaim } from "../support/fixtures.js";

describe("gitamesh_list_claims", () => {
  it("lists active resource claims, forwarding an optional repositoryId filter", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "GET /v1/claims": { body: { claims: [fakeClaim()] } },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const input = ListClaimsInputSchema.parse({ repositoryId: "repo_1" });
    const result = await handleListClaims(input, client);
    const parsed = ListClaimsOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.claims).toHaveLength(1);
    }
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("repositoryId")).toBe("repo_1");
  });
});
