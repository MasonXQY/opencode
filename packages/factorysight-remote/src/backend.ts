import type { Task } from "./shared"
import { availableModels as localModels } from "./models"
import { enqueueTask as enqueueLocalTask, enqueueTaskChain as enqueueLocalTaskChain } from "./runner"
import { enqueueFactorySightTask, enqueueFactorySightTaskChain, factorySightModels } from "./factorysight-client"

export type RemoteBackendMode = "local" | "factorysight"

export function remoteBackendMode(): RemoteBackendMode {
  return process.env.FACTORYSIGHT_REMOTE_BACKEND === "factorysight" ? "factorysight" : "local"
}

export async function backendModels() {
  return remoteBackendMode() === "factorysight" ? factorySightModels() : localModels()
}

export function enqueueBackendTask(task: Task) {
  return remoteBackendMode() === "factorysight" ? enqueueFactorySightTask(task) : enqueueLocalTask(task)
}

export function enqueueBackendTaskChain(parentTaskId: string, tasks: Task[]) {
  return remoteBackendMode() === "factorysight"
    ? enqueueFactorySightTaskChain(parentTaskId, tasks)
    : enqueueLocalTaskChain(parentTaskId, tasks)
}
