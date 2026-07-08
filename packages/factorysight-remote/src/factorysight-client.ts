import path from "node:path"
import { spawn } from "node:child_process"
import { appendEvent, createTask, getState, patchTask, setTaskStatus } from "./store"
import type { AgentMode, AgentProfile, PermissionLevel, Project, Task } from "./shared"
import { agentProfiles, defaultAgents, defaultModels, preferredDefaultModel } from "./shared"
import { availableModels as factorySightCliModels } from "./models"
import { attachedFileContext, appendDeliverable, runTask as runFactorySightCliTask } from "./runner"
import { runnerAgentFor } from "./agent-routing"
import {
  adaptiveOrchestrationSteps,
  adaptiveBatchKey,
  appendAdaptiveTaskIds,
  childPrompt,
  handoffText,
  limitAdaptiveSteps,
  orchestrationStepForTask,
  type OrchestrationScale,
} from "./orchestration"

type FactorySightSession = {
  id: string
  projectID?: string
  agent?: string
  model?: {
    providerID?: string
    id?: string
  }
  title?: string
  location?: {
    directory?: string
  }
  time?: {
    created?: number
    updated?: number
    archived?: number
  }
}

type FactorySightAgent = {
  id?: string
  name?: string
  mode?: AgentMode
  description?: string
  color?: string
  steps?: number
  permissions?: unknown[]
}

type FactorySightMessageState =
  | { status: "running"; text?: string }
  | { status: "completed"; text: string }
  | { status: "failed"; text: string }

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
  const data =
    typeof response === "object" && response && "data" in response ? (response as { data?: unknown }).data : response
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

export function selectAvailableFactorySightModel(requested: string, available: string[]) {
  return factorySightModelCandidates(requested, available)[0] ?? requested
}

export function factorySightModelCandidates(requested: string, available: string[]) {
  const unstableFallbackModels = new Set(["opencode/big-pickle", "opencode/minimax-m3-free"])
  const fallbackAvailable = available.filter((model) => model === requested || !unstableFallbackModels.has(model))
  const preferred = [
    requested,
    preferredDefaultModel,
    "opencode/hy3-free",
    "opencode/deepseek-v4-flash-free",
    "opencode/north-mini-code-free",
    "opencode/qwen3.6-plus-free",
  ]
  const candidates = [
    ...preferred.filter((model) => fallbackAvailable.includes(model)),
    ...fallbackAvailable.filter((model) => model.startsWith("opencode/")),
    ...fallbackAvailable.filter((model) => !model.startsWith("ollama/") && !model.startsWith("local/")),
    ...fallbackAvailable,
  ]
  return [...new Set(candidates)]
}

export function factorySightPermissionRules(level: PermissionLevel) {
  if (level === "full_auto") return [{ permission: "*", pattern: "*", action: "allow" }]
  if (level === "read_only")
    return [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "list", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "*", pattern: "*", action: "deny" },
    ]
  return undefined
}

export function factorySightApiArgs(method: string, requestPath: string, body?: unknown) {
  const args = ["api", method.toLowerCase(), requestPath]
  if (body !== undefined) args.push("--data", JSON.stringify(body))
  return args
}

export function factorySightApiUrl(baseUrl: string, requestPath: string) {
  return new URL(requestPath.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString()
}

export function isSessionWaitUnavailable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /ServiceUnavailableError|session\.wait|Session wait is not available yet/i.test(message)
}

function isFactorySightWaitTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /Timed out waiting for FactorySight session/i.test(message)
}

function textFromMessageContent(content: unknown) {
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return undefined
      const candidate = part as { type?: unknown; text?: unknown }
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : undefined
    })
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .trim()
}

export function sessionMessagesState(response: unknown): FactorySightMessageState {
  const data =
    typeof response === "object" && response && "data" in response ? (response as { data?: unknown }).data : response
  if (!Array.isArray(data)) return { status: "running" }
  const assistantMessages = data.filter((item) => {
    if (!item || typeof item !== "object") return false
    return (item as { type?: unknown }).type === "assistant"
  })
  const latest = assistantMessages.at(-1) as
    | { finish?: unknown; error?: unknown; content?: unknown; time?: { completed?: unknown } }
    | undefined
  if (!latest) return { status: "running" }

  if (latest.finish === "error") {
    const error = latest.error as { message?: unknown } | undefined
    return {
      status: "failed",
      text: typeof error?.message === "string" ? error.message : "FactorySight backend message failed",
    }
  }

  const text = textFromMessageContent(latest.content)
  if (typeof latest.finish === "string" || latest.time?.completed) {
    return { status: "completed", text: text || "FactorySight backend completed without text output." }
  }

  return { status: "running", text }
}

export async function withFactorySightTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function factorySightHttpApi(method: string, requestPath: string, body?: unknown) {
  const baseUrl = process.env.FACTORYSIGHT_BACKEND_URL
  if (!baseUrl) return undefined
  const response = await fetch(factorySightApiUrl(baseUrl, requestPath), {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(text || `FactorySight backend returned HTTP ${response.status}`)
  if (!text.trim()) return undefined
  return JSON.parse(text)
}

async function readText(stream: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true })
  return text
}

async function factorySightApi(method: string, requestPath: string, body?: unknown) {
  const httpResponse = await factorySightHttpApi(method, requestPath, body)
  if (httpResponse !== undefined || process.env.FACTORYSIGHT_BACKEND_URL) return httpResponse

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

async function waitForFactorySightSession(sessionId: string) {
  const timeoutMs = Number(process.env.FACTORYSIGHT_REMOTE_SESSION_WAIT_MS ?? 15_000)
  let waitSucceeded = false
  let waitError: unknown
  void withFactorySightTimeout(
    factorySightApi("POST", `/api/session/${encodeURIComponent(sessionId)}/wait`),
    `FactorySight session ${sessionId}`,
    timeoutMs,
  )
    .then(() => {
      waitSucceeded = true
    })
    .catch((error) => {
      waitError = error
    })

  const intervalMs = Number(process.env.FACTORYSIGHT_REMOTE_SESSION_POLL_MS ?? 1_000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = sessionMessagesState(
      await factorySightApi("GET", `/api/session/${encodeURIComponent(sessionId)}/message?order=asc&limit=50`),
    )
    if (state.status === "completed") return state.text
    if (state.status === "failed") throw new Error(state.text)
    if (waitSucceeded) return
    if (waitError && !isSessionWaitUnavailable(waitError) && !isFactorySightWaitTimeout(waitError)) throw waitError
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  if (waitError && !isSessionWaitUnavailable(waitError) && !isFactorySightWaitTimeout(waitError)) throw waitError
  throw new Error(`Timed out waiting for FactorySight session ${sessionId}`)
}

export async function factorySightModels() {
  try {
    return modelsFromFactorySightResponse(await factorySightApi("GET", "/api/model"))
  } catch {
    return factorySightCliModels().catch(() => defaultModels)
  }
}

function initialsFromAgentId(id: string) {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase())
    .join("")
    .slice(0, 2)
}

function titleFromAgentId(id: string) {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function agentPermissionSummary(value: unknown[] | undefined) {
  if (!value) return undefined
  return value
    .map((item) => {
      if (typeof item === "string") return item
      if (!item || typeof item !== "object") return undefined
      const candidate = item as { permission?: unknown; action?: unknown; type?: unknown }
      const permission = typeof candidate.permission === "string" ? candidate.permission : candidate.type
      const action = typeof candidate.action === "string" ? candidate.action : undefined
      return typeof permission === "string" ? [permission, action].filter(Boolean).join(":") : undefined
    })
    .filter((item): item is string => Boolean(item))
}

export function agentsFromFactorySightResponse(response: unknown) {
  const data =
    typeof response === "object" && response && "data" in response ? (response as { data?: unknown }).data : response
  if (!Array.isArray(data)) {
    return {
      agents: defaultAgents,
      agentProfiles,
    }
  }

  const profiles: Record<string, AgentProfile> = {}
  for (const item of data) {
    if (!item || typeof item !== "object") continue
    const candidate = item as FactorySightAgent
    const id =
      typeof candidate.id === "string" ? candidate.id : typeof candidate.name === "string" ? candidate.name : undefined
    if (!id) continue
    const fallback = agentProfiles[id]
    profiles[id] = {
      id,
      name: fallback?.name ?? titleFromAgentId(id),
      title: fallback?.title ?? titleFromAgentId(id),
      initials: fallback?.initials ?? initialsFromAgentId(id),
      color: typeof candidate.color === "string" ? candidate.color : (fallback?.color ?? "#8f8f8f"),
      summary:
        typeof candidate.description === "string"
          ? candidate.description
          : (fallback?.summary ?? "FactorySight backend agent."),
      mode: candidate.mode ?? fallback?.mode ?? "all",
      backend: "factorysight",
      steps: typeof candidate.steps === "number" ? candidate.steps : fallback?.steps,
      permissions: agentPermissionSummary(candidate.permissions) ?? fallback?.permissions,
    }
  }

  const agents = Object.keys(profiles)
  return agents.length
    ? {
        agents,
        agentProfiles: profiles,
      }
    : {
        agents: defaultAgents,
        agentProfiles,
      }
}

export async function factorySightAgents() {
  try {
    return agentsFromFactorySightResponse(await factorySightApi("GET", "/api/agent"))
  } catch {
    return {
      agents: defaultAgents,
      agentProfiles,
    }
  }
}

function modelFromFactorySightSession(session: FactorySightSession) {
  const providerID = session.model?.providerID
  const id = session.model?.id
  if (providerID && id) return `${providerID}/${id}`
  return preferredDefaultModel
}

function isoFromMillis(value: number | undefined) {
  return new Date(value ?? Date.now()).toISOString()
}

export function factorySightSessionToTask(session: FactorySightSession, userId: string, projectId?: string): Task {
  const at = isoFromMillis(session.time?.updated ?? session.time?.created)
  const taskId = `fs_${session.id}`
  return {
    id: taskId,
    projectId: projectId ?? `fs_${session.projectID ?? "default"}`,
    creatorId: userId,
    kind: "single",
    title: session.title?.trim() || `FactorySight session ${session.id}`,
    prompt: `FactorySight session ${session.id}`,
    agent: session.agent?.trim() || "build",
    model: modelFromFactorySightSession(session),
    status: session.time?.archived ? "archived" : "completed",
    collaboration: "project",
    createdAt: isoFromMillis(session.time?.created),
    updatedAt: at,
    sessionId: session.id,
    events: [
      {
        id: `evt_${taskId}_session`,
        taskId,
        at,
        type: "system",
        text: [
          `FactorySight session: ${session.id}`,
          session.location?.directory ? `Workspace: ${session.location.directory}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  }
}

function sessionsFromFactorySightResponse(response: unknown) {
  const data =
    typeof response === "object" && response && "data" in response ? (response as { data?: unknown }).data : response
  if (!Array.isArray(data)) return []
  return data.filter((item): item is FactorySightSession => {
    if (!item || typeof item !== "object") return false
    return typeof (item as { id?: unknown }).id === "string"
  })
}

export async function factorySightTasksForProjects(userId: string, projects: Project[]) {
  try {
    const response = await factorySightApi("GET", "/api/session?limit=100")
    return sessionsFromFactorySightResponse(response)
      .map((session) => {
        const project = projects.find(
          (item) => session.location?.directory && path.resolve(item.path) === path.resolve(session.location.directory),
        )
        if (!project) return
        return factorySightSessionToTask(session, userId, project.id)
      })
      .filter((task): task is Task => Boolean(task))
  } catch {
    return []
  }
}

function canFallbackToFactorySightCli(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /Commands:|Unknown command|Invalid command|Did you mean/i.test(message)
}

export function isFactorySightTransportFallbackError(error: unknown) {
  return canFallbackToFactorySightCli(error)
}

function isRetryableFactorySightModelError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /Timed out waiting for FactorySight session|tool call delta is missing id or name|model .*not found|Provider request failed|Provider API error/i.test(
    message,
  )
}

async function runFactorySightTaskAttempt(task: Task, project: Project, runnerAgent: string, selectedModel: string) {
  const session = (await factorySightApi("POST", "/api/session", {
    agent: runnerAgent,
    model: modelRefFromString(selectedModel),
    permission: factorySightPermissionRules(project.permissionLevel),
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
  const output = await waitForFactorySightSession(sessionId)
  if (output) await appendEvent(task.id, { type: "runner", text: output })
  await appendDeliverable(task, project.path, 0)
  await setTaskStatus(task.id, "completed", "FactorySight backend completed task")
}

async function runFactorySightTask(task: Task, project: Project) {
  const runnerAgent = runnerAgentFor(task.agent)
  const modelCandidates = factorySightModelCandidates(task.model, await factorySightModels())
  if (modelCandidates.length === 0) modelCandidates.push(task.model)
  const selectedModel = modelCandidates[0] ?? task.model
  await setTaskStatus(task.id, "running", `FactorySight backend started ${task.agent} on ${selectedModel}`)
  await appendEvent(task.id, { type: "runner", text: `Workspace: ${project.path}` })
  if (selectedModel !== task.model) {
    await appendEvent(task.id, {
      type: "system",
      text: `Requested model ${task.model} is not available in the FactorySight backend. Using ${selectedModel}.`,
    })
  }
  if (runnerAgent !== task.agent) {
    await appendEvent(task.id, {
      type: "system",
      text: `Role ${task.agent} is represented through FactorySight primary agent ${runnerAgent}.`,
    })
  }

  for (const [index, candidate] of modelCandidates.entries()) {
    try {
      if (index > 0) {
        await setTaskStatus(task.id, "running", `Retrying FactorySight backend with ${candidate}`)
        await appendEvent(task.id, { type: "system", text: `Retrying with backend model ${candidate}.` })
      }
      await runFactorySightTaskAttempt(task, project, runnerAgent, candidate)
      return
    } catch (error) {
      if (isFactorySightTransportFallbackError(error)) {
        await appendEvent(task.id, {
          type: "system",
          text: "FactorySight HTTP transport did not complete this task. Falling back to FactorySight CLI transport.",
        })
        await runFactorySightCliTask(task.id)
        return
      }
      const hasNextCandidate = index < modelCandidates.length - 1
      if (!hasNextCandidate || !isRetryableFactorySightModelError(error)) throw error
      await appendEvent(task.id, {
        type: "system",
        text: `Backend model ${candidate} failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
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

export function enqueueFactorySightTaskChain(
  parentTaskId: string,
  tasks: Task[],
  scale: OrchestrationScale = "balanced",
) {
  const taskIds = tasks.map((task) => task.id)
  void runFactorySightTaskChain(parentTaskId, taskIds, scale)
}

async function appendAdaptiveFactorySightChildren(
  parent: Task,
  completed: Task,
  taskIds: string[],
  scale: OrchestrationScale,
) {
  const state = await getState()
  const batchKey = adaptiveBatchKey(completed.agent)
  if (batchKey && parent.events.some((event) => event.text.includes(`Adaptive topology batch ${batchKey}`))) return
  const currentChildren = state.tasks.filter((task) => task.parentTaskId === parent.id)
  const completedOutput = completed.events
    .filter((event) => ["deliverable", "runner", "error", "handoff", "system"].includes(event.type))
    .slice(-20)
    .map((event) => event.text)
    .join("\n")
  const availableAgents = (await factorySightAgents()).agents
  const maxChildren = Number(process.env.FACTORYSIGHT_REMOTE_MAX_WORKFLOW_CHILDREN ?? 8)
  const steps = limitAdaptiveSteps(
    adaptiveOrchestrationSteps({
      prompt: parent.prompt,
      scale,
      completedAgent: completed.agent,
      existingAgents: currentChildren.map((task) => task.agent),
      completedOutput,
      availableAgents,
    }),
    currentChildren.length,
    maxChildren,
  )
  if (!steps.length) return

  const created: Task[] = []
  for (const step of steps) {
    const child = await createTask({
      creatorId: parent.creatorId,
      projectId: parent.projectId,
      parentTaskId: parent.id,
      title: step.title,
      prompt: childPrompt(parent, step),
      agent: step.agent,
      model: parent.model,
      collaboration: parent.collaboration,
      kind: "single",
    })
    created.push(child)
    await appendEvent(parent.id, {
      type: "system",
      text: `Adaptive topology batch ${batchKey ?? step.phase} added ${step.phase} role ${step.agent}: ${step.title}`,
    })
  }
  const createdIds = created.map((task) => task.id)
  taskIds.splice(0, taskIds.length, ...appendAdaptiveTaskIds(taskIds, createdIds))
  await patchTask(parent.id, { childTaskIds: appendAdaptiveTaskIds(parent.childTaskIds ?? taskIds, createdIds) })
}

async function runFactorySightTaskChain(parentTaskId: string, taskIds: string[], scale: OrchestrationScale) {
  await setTaskStatus(parentTaskId, "running", "FactorySight backend planning and dispatch started")
  for (let index = 0; index < taskIds.length; index++) {
    const taskId = taskIds[index]
    const state = await getState()
    const parent = state.tasks.find((item) => item.id === parentTaskId)
    const task = state.tasks.find((item) => item.id === taskId)
    if (!parent || !task) continue
    const step = orchestrationStepForTask(parent, task, scale, (await factorySightAgents()).agents)
    const previous =
      index === 0
        ? "orchestrator"
        : (state.tasks.find((item) => item.id === taskIds[index - 1])?.agent ?? "orchestrator")
    await appendEvent(parentTaskId, {
      type: "handoff",
      text: handoffText({ from: previous, to: task.agent, step, status: "offered" }),
    })
    await appendEvent(parentTaskId, { type: "system", text: `Starting ${task.agent}: ${task.title}` })
    await runFactorySightTaskById(task.id)
    let updated = (await getState()).tasks.find((item) => item.id === task.id)
    if (updated?.status === "failed" && step.failurePolicy === "retry") {
      await appendEvent(parentTaskId, {
        type: "handoff",
        text: `Retrying ${task.agent} once because this handoff is required for downstream work.`,
      })
      await runFactorySightTaskById(task.id)
      updated = (await getState()).tasks.find((item) => item.id === task.id)
    }
    if (updated?.status === "failed") {
      await appendEvent(parentTaskId, {
        type: "error",
        text:
          step.failurePolicy === "continue"
            ? `${task.agent} failed in FactorySight backend. Continuing because this handoff is non-blocking.`
            : `${task.agent} failed in FactorySight backend. Stopping the remaining orchestration chain.`,
      })
      await appendEvent(parentTaskId, {
        type: "handoff",
        text: handoffText({ from: task.agent, to: "orchestrator", step, status: "failed" }),
      })
      if (step.failurePolicy === "continue") {
        await appendEvent(parentTaskId, {
          type: "handoff",
          text: handoffText({ from: task.agent, to: "orchestrator", step, status: "continued" }),
        })
        continue
      }
      await setTaskStatus(parentTaskId, "failed", `Stopped after ${task.agent} failed`)
      return
    }
    await appendEvent(parentTaskId, {
      type: "handoff",
      text: handoffText({ from: task.agent, to: "orchestrator", step, status: "accepted" }),
    })
    await appendEvent(parentTaskId, { type: "system", text: `Completed ${task.agent}: ${task.title}` })
    await appendAdaptiveFactorySightChildren(parent, updated ?? task, taskIds, scale)
  }
  await setTaskStatus(parentTaskId, "completed", "FactorySight backend orchestration completed")
}
