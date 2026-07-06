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

export function taskTitleFromPrompt(value: string) {
  const text = value
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, "")
    .trim()
  if (!text) return "Untitled mission"
  const sentence = text.split(/(?<=[。！？.!?])\s+/)[0] ?? text
  const cleaned = sentence.replace(/^(please|can you|could you|help me|帮我|请|麻烦你|你能否|能否)\s*/i, "").trim()
  const title = cleaned || text
  return title.length > 72 ? `${title.slice(0, 72).trim()}...` : title
}

export function preferredSpeechLanguage(languages: readonly string[] = []) {
  return languages.find((language) => language.toLowerCase().startsWith("zh")) ?? languages[0] ?? "zh-CN"
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
