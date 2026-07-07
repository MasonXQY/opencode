import type { Project, Task } from "./shared"
import type { OrchestrationScale } from "./orchestration"
import { availableModels as localModels } from "./models"
import { enqueueTask as enqueueLocalTask, enqueueTaskChain as enqueueLocalTaskChain } from "./runner"
import {
  factorySightAgents,
  enqueueFactorySightTask,
  enqueueFactorySightTaskChain,
  factorySightModels,
  factorySightTasksForProjects,
} from "./factorysight-client"
import { agentProfiles, defaultAgents } from "./shared"

export type RemoteBackendMode = "local" | "factorysight"

export function remoteBackendMode(): RemoteBackendMode {
  return process.env.FACTORYSIGHT_REMOTE_BACKEND === "factorysight" ? "factorysight" : "local"
}

export async function backendModels() {
  return remoteBackendMode() === "factorysight" ? factorySightModels() : localModels()
}

export async function backendAgents() {
  return remoteBackendMode() === "factorysight"
    ? factorySightAgents()
    : {
        agents: defaultAgents,
        agentProfiles,
      }
}

export function mergeFactorySightTasks(
  localTasks: Task[],
  factorySightTasks: Task[],
  hiddenFactorySightSessionIds: string[] = [],
) {
  const hiddenSessionIds = new Set(hiddenFactorySightSessionIds)
  const tasks = [...localTasks]
  const existingIds = new Set(tasks.map((task) => task.id))
  for (const task of factorySightTasks) {
    if (task.sessionId && hiddenSessionIds.has(task.sessionId)) continue
    if (!existingIds.has(task.id)) {
      tasks.push(task)
      existingIds.add(task.id)
    }
  }
  return tasks.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
}

export async function backendTasks(
  localTasks: Task[],
  projects: Project[],
  userId: string,
  hiddenFactorySightSessionIds: string[] = [],
) {
  if (remoteBackendMode() !== "factorysight") return localTasks
  const factorySightTasks = await factorySightTasksForProjects(userId, projects)
  return mergeFactorySightTasks(localTasks, factorySightTasks, hiddenFactorySightSessionIds)
}

export function enqueueBackendTask(task: Task) {
  return remoteBackendMode() === "factorysight" ? enqueueFactorySightTask(task) : enqueueLocalTask(task)
}

export function enqueueBackendTaskChain(parentTaskId: string, tasks: Task[], scale: OrchestrationScale = "balanced") {
  return remoteBackendMode() === "factorysight"
    ? enqueueFactorySightTaskChain(parentTaskId, tasks, scale)
    : enqueueLocalTaskChain(parentTaskId, tasks, scale)
}
