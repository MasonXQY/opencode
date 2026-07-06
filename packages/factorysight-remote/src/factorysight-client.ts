import path from "node:path"
import { spawn } from "node:child_process"
import { appendEvent, getState, patchTask, setTaskStatus } from "./store"
import type { Project, Task } from "./shared"
import { defaultModels, preferredDefaultModel } from "./shared"
import { availableModels as factorySightCliModels } from "./models"
import { attachedFileContext, appendDeliverable, runTask as runFactorySightCliTask } from "./runner"
import { runnerAgentFor } from "./agent-routing"

function binaryPath() {
  return (
    process.env.FACTORYSIGHT_BIN ??
    (process.env.HOME ? path.join(process.env.HOME, ".opencode", "bin", "factorysight") : "factorysight")
  )
}

export function modelRefFromString(model: string) {
  const [providerID, ...idParts] = model.split("/")
  return {
    providerID: providerID || "anthropic",
    id: idParts.join("/") || model,
  }
}

export function modelsFromFactorySightResponse(response: unknown) {
  const data = typeof response === "object" && response && "data" in response ? (response as { data?: unknown }).data : response
  if (!Array.isArray(data)) return defaultModels
  const models = data
    .filter((item): item is { providerID: string; id: string; enabled?: boolean } => {
      if (!item || typeof item !== "object") return false
      const candidate = item as { providerID?: unknown; id?: unknown; enabled?: unknown }
      return typeof candidate.providerID === "string" && typeof candidate.id === "string" && candidate.enabled !== false
    })
    .map((item) => `${item.providerID}/${item.id}`)
    .filter((item, index, items) => items.indexOf(item) === index)
    .sort((left, right) => left.localeCompare(right))

  return models.includes(preferredDefaultModel)
    ? [preferredDefaultModel, ...models.filter((model) => model !== preferredDefaultModel)]
    : models.length
      ? models
      : defaultModels
}

export function factorySightApiArgs(method: string, requestPath: string, body?: unknown) {
  const args = ["api", method.toLowerCase(), requestPath]
  if (body !== undefined) args.push("--data", JSON.stringify(body))
  return args
}

async function readText(stream: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true })
  return text
}

async function factorySightApi(method: string, requestPath: string, body?: unknown) {
  const proc = spawn(binaryPath(), factorySightApiArgs(method, requestPath, body), {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? readText(proc.stdout) : Promise.resolve(""),
    proc.stderr ? readText(proc.stderr) : Promise.resolve(""),
    new Promise<number | null>((resolve) => proc.on("close", resolve)),
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `FactorySight API exited with code ${exitCode}`)
  if (!stdout.trim()) return undefined
  return JSON.parse(stdout)
}

export async function factorySightModels() {
  try {
    return modelsFromFactorySightResponse(await factorySightApi("GET", "/api/model"))
  } catch {
    return factorySightCliModels().catch(() => defaultModels)
  }
}

function canFallbackToFactorySightCli(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /Commands:|Unknown command|Invalid command|Did you mean/i.test(message)
}

async function runFactorySightTask(task: Task, project: Project) {
  const runnerAgent = runnerAgentFor(task.agent)
  await setTaskStatus(task.id, "running", `FactorySight backend started ${task.agent} on ${task.model}`)
  await appendEvent(task.id, { type: "runner", text: `Workspace: ${project.path}` })
  if (runnerAgent !== task.agent) {
    await appendEvent(task.id, {
      type: "system",
      text: `Role ${task.agent} is represented through FactorySight primary agent ${runnerAgent}.`,
    })
  }

  try {
    const session = (await factorySightApi("POST", "/api/session", {
      agent: runnerAgent,
      model: modelRefFromString(task.model),
      location: { directory: project.path },
    })) as { data?: { id?: string } } | undefined
    const sessionId = session?.data?.id
    if (!sessionId) throw new Error("FactorySight did not return a session id")
    await patchTask(task.id, { sessionId })
    await appendEvent(task.id, { type: "system", text: `FactorySight session created: ${sessionId}` })

    await factorySightApi("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      prompt: { text: await attachedFileContext(task, project.path) },
    })
    await appendEvent(task.id, { type: "system", text: "Prompt sent to FactorySight backend" })
    await factorySightApi("POST", `/api/session/${encodeURIComponent(sessionId)}/wait`)
    await appendDeliverable(task, project.path, 0)
    await setTaskStatus(task.id, "completed", "FactorySight backend completed task")
  } catch (error) {
    if (!canFallbackToFactorySightCli(error)) throw error
    await appendEvent(task.id, {
      type: "system",
      text: "FactorySight API is not available in this installation. Falling back to FactorySight CLI transport.",
    })
    await runFactorySightCliTask(task.id)
  }
}

export async function enqueueFactorySightTask(task: Task) {
  void runFactorySightTaskById(task.id)
}

async function runFactorySightTaskById(taskId: string) {
  try {
    const state = await getState()
    const task = state.tasks.find((item) => item.id === taskId)
    if (!task) return
    const project = state.projects.find((item) => item.id === task.projectId)
    if (!project) {
      await setTaskStatus(taskId, "failed", "Project not found")
      return
    }
    await runFactorySightTask(task, project)
  } catch (error) {
    await patchTask(taskId, { runnerPid: undefined })
    await appendEvent(taskId, {
      type: "error",
      text: error instanceof Error ? error.message : String(error),
    }).catch(() => {})
    await setTaskStatus(taskId, "failed", "FactorySight backend task failed").catch(() => {})
  }
}

export function enqueueFactorySightTaskChain(parentTaskId: string, tasks: Task[]) {
  const taskIds = tasks.map((task) => task.id)
  void runFactorySightTaskChain(parentTaskId, taskIds)
}

async function runFactorySightTaskChain(parentTaskId: string, taskIds: string[]) {
  await setTaskStatus(parentTaskId, "running", "FactorySight backend planning and dispatch started")
  for (const taskId of taskIds) {
    const state = await getState()
    const task = state.tasks.find((item) => item.id === taskId)
    if (!task) continue
    await appendEvent(parentTaskId, { type: "system", text: `Starting ${task.agent}: ${task.title}` })
    await runFactorySightTaskById(task.id)
    const updated = (await getState()).tasks.find((item) => item.id === task.id)
    if (updated?.status === "failed") {
      await appendEvent(parentTaskId, {
        type: "error",
        text: `${task.agent} failed in FactorySight backend. Stopping the remaining orchestration chain.`,
      })
      await setTaskStatus(parentTaskId, "failed", `Stopped after ${task.agent} failed`)
      return
    }
    await appendEvent(parentTaskId, { type: "system", text: `Completed ${task.agent}: ${task.title}` })
  }
  await setTaskStatus(parentTaskId, "completed", "FactorySight backend orchestration completed")
}
