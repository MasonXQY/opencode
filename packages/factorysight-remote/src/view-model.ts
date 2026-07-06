import type { Artifact } from "./shared"

export function artifactsForProject(artifacts: Artifact[], projectId: string | undefined) {
  if (!projectId) return []
  return artifacts.filter((artifact) => artifact.projectId === projectId)
}
