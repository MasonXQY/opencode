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

type SelectableTask = {
  id: string
  projectId: string
  updatedAt: string
}

export function nextSelectedTaskId(
  tasks: SelectableTask[],
  activeProjectId: string | undefined,
  currentTaskId: string | undefined,
  createdTaskId?: string,
) {
  if (!activeProjectId) return undefined
  const projectTasks = tasks.filter((task) => task.projectId === activeProjectId)
  if (createdTaskId && projectTasks.some((task) => task.id === createdTaskId)) return createdTaskId
  if (currentTaskId && projectTasks.some((task) => task.id === currentTaskId)) return currentTaskId
  return projectTasks
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .at(0)?.id
}
