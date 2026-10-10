import { z } from "zod";
import { RepositorySchema } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

type Repository = z.infer<typeof RepositorySchema>;

export const RegisterRepositoryInputSchema = z.object({
  displayName: z.string().min(1),
  gitCommonDir: z.string().min(1).describe("Absolute path of the repository's common .git directory."),
  defaultBranch: z.string().min(1),
  namespaceId: z.string().min(1).optional(),
  repositoryId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The id the gitamesh CLI derived for this clone (`gitamesh repo status`). Sent as metadata.local_repository_id, which the daemon uses as the repository_id.",
    ),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const RegisterRepositoryOutputSchema = z.union([
  z.object({ ok: z.literal(true), repository: RepositorySchema, replayed: z.boolean() }),
  ToolErrorSchema,
]);

export async function handleRegisterRepository(
  input: z.infer<typeof RegisterRepositoryInputSchema>,
  client: DaemonClient,
): Promise<{ ok: true; repository: Repository; replayed: boolean } | ToolError> {
  const metadata = { ...(input.metadata ?? {}) };
  if (input.repositoryId !== undefined) metadata.local_repository_id = input.repositoryId;

  const result = await client.registerRepository({
    namespace_id: input.namespaceId,
    display_name: input.displayName,
    git_common_dir: input.gitCommonDir,
    default_branch: input.defaultBranch,
    metadata,
  });
  return fromDaemonResult(result, (data) => ({
    ok: true as const,
    repository: data.repository as Repository,
    replayed: data.replayed,
  }));
}

export const ListRepositoriesInputSchema = z.object({});

export const ListRepositoriesOutputSchema = z.union([
  z.object({ ok: z.literal(true), repositories: z.array(RepositorySchema) }),
  ToolErrorSchema,
]);

export async function handleListRepositories(
  _input: z.infer<typeof ListRepositoriesInputSchema>,
  client: DaemonClient,
): Promise<{ ok: true; repositories: Repository[] } | ToolError> {
  const result = await client.listRepositories();
  return fromDaemonResult(result, (data) => ({
    ok: true as const,
    repositories: data.repositories as Repository[],
  }));
}
