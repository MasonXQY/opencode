import type { Artifact } from "./shared"

export function artifactsForProject(artifacts: Artifact[], projectId: string | undefined) {
  if (!projectId) return []
  return artifacts.filter((artifact) => artifact.projectId === projectId)
}

export function slugProjectName(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  )
}

export function defaultProjectPath(
  name: string,
  suffix: string,
  basePath = "/Users/mason/Documents/FactorySight Projects",
) {
  return `${basePath}/${slugProjectName(name)}-${suffix}`
}
