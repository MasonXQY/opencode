import path from "node:path"
import { spawn } from "node:child_process"
import { appendEvent, createTask, getState, patchTask, setTaskStatus } from "./store"
import type { Task } from "./shared"
import { adaptiveOrchestrationSteps, childPrompt, type OrchestrationScale } from "./orchestration"
import { listProjectFiles } from "./file-storage"
import { runnerAgentFor } from "./agent-routing"
import { writeTaskDeliverableArtifact } from "./artifact-storage"

const running = new Set<string>()

function binaryPath() {
  return (
    process.env.FACTORYSIGHT_BIN ??
    (process.env.HOME ? path.join(process.env.HOME, ".opencode", "bin", "factorysight") : "factorysight")
  )
}

function decoder() {
  return new TextDecoder()
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runMockTask(task: Task, projectPath: string) {
  await setTaskStatus(task.id, "running", `Demo runner started with ${task.agent} on ${task.model}`)
  await appendEvent(task.id, { type: "runner", text: `Workspace: ${projectPath}` })
  await appendEvent(task.id, { type: "runner", text: "Planning the task and checking project context." })
  await sleep(350)
  await appendEvent(task.id, { type: "runner", text: "Assigning work to the selected agent role." })
  await sleep(350)
  await appendEvent(task.id, { type: "runner", text: "Drafting implementation notes and collaboration handoff." })
  await sleep(350)
  await appendEvent(task.id, {
    type: "deliverable",
    text: "Demo deliverable\n\n- Summary: task completed successfully in demo mode.\n- Files changed: demo mode does not modify files.\n- Verification: runner lifecycle completed.",
  })
  await setTaskStatus(task.id, "completed", "Demo task completed")
}

async function readText(stream: AsyncIterable<Uint8Array>) {
  let text = ""
  for await (const chunk of stream) {
    text += decoder().decode(chunk, { stream: true })
  }
  return text
}

async function gitStatus(projectPath: string) {
  try {
    const proc = spawn("git", ["status", "--short"], {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const [stdout, exitCode] = await Promise.all([
      proc.stdout ? readText(proc.stdout) : Promise.resolve(""),
      new Promise<number | null>((resolve) => proc.on("close", resolve)),
      proc.stderr ? readText(proc.stderr) : Promise.resolve(""),
    ])
    if (exitCode !== 0) return "Git status unavailable."
    const files = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (files.length === 0) return "No file changes reported by git."
    return files.map((line) => `- ${line}`).join("\n")
  } catch (error) {
    return error instanceof Error ? `Git status unavailable: ${error.message}` : "Git status unavailable."
  }
}

export async function appendDeliverable(task: Task, projectPath: string, exitCode: number) {
  const files = await gitStatus(projectPath)
  const text = [
    "Final deliverable",
    "",
    `- Agent: ${task.agent}`,
    `- Model: ${task.model}`,
    `- Result: ${exitCode === 0 ? "completed" : `failed with exit code ${exitCode}`}`,
    "",
    "Files changed:",
    files,
  ].join("\n")
  await writeTaskDeliverableArtifact(task, projectPath, text)
  await appendEvent(task.id, {
    type: "deliverable",
    text,
  })
}

export async function attachedFileContext(task: Task, projectPath: string) {
  const files = (await listProjectFiles(projectPath)).filter(
    (file) => file.scope === "project" || file.taskId === task.id || file.taskId === task.parentTaskId,
  )
  if (files.length === 0) return task.prompt
  const fileList = files.map((file) => `- ${file.relativePath} (${file.originalName})`).join("\n")
  return `${task.prompt}\n\nAttached files available in the workspace:\n${fileList}`
}

async function appendOutput(taskId: string, type: "runner" | "error", chunk: Uint8Array | undefined) {
  if (!chunk?.length) return
  const text = decoder().decode(chunk).trim()
  if (!text) return
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    await appendEvent(taskId, { type, text: line })
  }
}

async function readOutput(taskId: string, type: "runner" | "error", stream: AsyncIterable<Uint8Array>) {
  let text = ""
  for await (const chunk of stream) {
    text += decoder().decode(chunk)
    await appendOutput(taskId, type, chunk)
  }
  return text
}

export async function runTask(taskId: string) {
  if (running.has(taskId)) return
  running.add(taskId)
  try {
    const state = await getState()
    const task = state.tasks.find((item) => item.id === taskId)
    if (!task) return
    const project = state.projects.find((item) => item.id === task.projectId)
    if (!project) {
      await setTaskStatus(taskId, "failed", "Project not found")
      return
    }

    if (process.env.FACTORYSIGHT_REMOTE_RUNNER === "mock") {
      await runMockTask(task, project.path)
      return
    }

    const bin = binaryPath()
    const runnerAgent = runnerAgentFor(task.agent)
    await setTaskStatus(taskId, "running", `Runner started with ${task.agent} on ${task.model}`)
    await appendEvent(taskId, { type: "runner", text: `Workspace: ${project.path}` })
    if (runnerAgent !== task.agent) {
      await appendEvent(taskId, {
        type: "system",
        text: `Role ${task.agent} is running through primary agent ${runnerAgent}.`,
      })
    }
    const prompt = await attachedFileContext(task, project.path)

    const args = [
      bin,
      "run",
      prompt,
      "--format",
      "json",
      "--agent",
      runnerAgent,
      "--model",
      task.model,
      "--dir",
      project.path,
    ]
    if (project.permissionLevel === "full_auto") args.push("--auto")
    await appendEvent(taskId, {
      type: "system",
      text: `Permission level: ${project.permissionLevel ?? "ask"}`,
    })

    const [command, ...commandArgs] = args
    if (!command) throw new Error("Runner command is empty")
    const proc = spawn(command, commandArgs, {
      cwd: project.path,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    })
    await patchTask(taskId, { runnerPid: proc.pid })

    const exitCodePromise = new Promise<number | null>((resolve) => proc.on("close", resolve))
    const [stdoutText, stderrText] = await Promise.all([
      proc.stdout ? readOutput(taskId, "runner", proc.stdout) : Promise.resolve(),
      proc.stderr ? readOutput(taskId, "error", proc.stderr) : Promise.resolve(),
    ])

    const exitCode = (await exitCodePromise) ?? 1
    await patchTask(taskId, { runnerPid: undefined })
    await appendDeliverable(task, project.path, exitCode)
    const combinedOutput = `${stdoutText ?? ""}\n${stderrText ?? ""}`
    const permissionAutoRejected = /permission requested:|auto-rejecting/i.test(combinedOutput)
    if (exitCode === 0 && !permissionAutoRejected) {
      await setTaskStatus(taskId, "completed", "Task completed")
    } else if (permissionAutoRejected) {
      await setTaskStatus(taskId, "failed", "Permission request was auto-rejected")
    } else {
      await setTaskStatus(taskId, "failed", `Runner exited with code ${exitCode}`)
    }
  } catch (error) {
    await patchTask(taskId, { runnerPid: undefined })
    await appendEvent(taskId, {
      type: "error",
      text: error instanceof Error ? error.message : String(error),
    }).catch(() => {})
    await setTaskStatus(taskId, "failed", "Runner failed").catch(() => {})
  } finally {
    running.delete(taskId)
  }
}

export function enqueueTask(task: Task) {
  void runTask(task.id)
}

export function enqueueTaskChain(parentTaskId: string, tasks: Task[], scale: OrchestrationScale = "balanced") {
  const taskIds = tasks.map((task) => task.id)
  void runTaskChain(parentTaskId, taskIds, scale)
}

async function appendAdaptiveChildren(
  parent: Task,
  completed: Task,
  taskIds: string[],
  insertAfterIndex: number,
  scale: OrchestrationScale,
) {
  const state = await getState()
  const currentChildren = state.tasks.filter((task) => task.parentTaskId === parent.id)
  const steps = adaptiveOrchestrationSteps({
    prompt: parent.prompt,
    scale,
    completedAgent: completed.agent,
    existingAgents: currentChildren.map((task) => task.agent),
  })
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
      text: `Adaptive topology added ${step.phase} role ${step.agent}: ${step.title}`,
    })
  }
  taskIds.splice(insertAfterIndex + 1, 0, ...created.map((task) => task.id))
  const nextChildren = (parent.childTaskIds ?? taskIds).filter((id) => !created.some((task) => task.id === id))
  nextChildren.splice(insertAfterIndex + 1, 0, ...created.map((task) => task.id))
  await patchTask(parent.id, { childTaskIds: nextChildren })
}

async function runTaskChain(parentTaskId: string, taskIds: string[], scale: OrchestrationScale) {
  await setTaskStatus(parentTaskId, "running", "Main agent planning and dispatch started")
  for (let index = 0; index < taskIds.length; index++) {
    const taskId = taskIds[index]
    const state = await getState()
    const parent = state.tasks.find((item) => item.id === parentTaskId)
    const task = state.tasks.find((item) => item.id === taskId)
    if (!parent || !task) continue
    await appendEvent(parentTaskId, {
      type: "system",
      text: `Starting ${task.agent}: ${task.title}`,
    })
    await runTask(task.id)
    const updated = (await getState()).tasks.find((item) => item.id === task.id)
    if (updated?.status === "failed") {
      await appendEvent(parentTaskId, {
        type: "error",
        text: `${task.agent} failed. Stopping the remaining orchestration chain.`,
      })
      await setTaskStatus(parentTaskId, "failed", `Stopped after ${task.agent} failed`)
      return
    }
    await appendEvent(parentTaskId, {
      type: "system",
      text: `Completed ${task.agent}: ${task.title}`,
    })
    await appendAdaptiveChildren(parent, task, taskIds, index, scale)
  }
  await setTaskStatus(parentTaskId, "completed", "Orchestration chain completed")
}
