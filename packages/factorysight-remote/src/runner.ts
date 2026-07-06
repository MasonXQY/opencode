import path from "node:path"
import { appendEvent, getState, patchTask, setTaskStatus } from "./store"
import type { Task } from "./shared"

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

async function runMockTask(task: Task, projectPath: string) {
  await setTaskStatus(task.id, "running", `Demo runner started with ${task.agent} on ${task.model}`)
  await appendEvent(task.id, { type: "runner", text: `Workspace: ${projectPath}` })
  await appendEvent(task.id, { type: "runner", text: "Planning the task and checking project context." })
  await Bun.sleep(350)
  await appendEvent(task.id, { type: "runner", text: "Assigning work to the selected agent role." })
  await Bun.sleep(350)
  await appendEvent(task.id, { type: "runner", text: "Drafting implementation notes and collaboration handoff." })
  await Bun.sleep(350)
  await appendEvent(task.id, {
    type: "deliverable",
    text: "Demo deliverable\n\n- Summary: task completed successfully in demo mode.\n- Files changed: demo mode does not modify files.\n- Verification: runner lifecycle completed.",
  })
  await setTaskStatus(task.id, "completed", "Demo task completed")
}

async function readText(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

async function gitStatus(projectPath: string) {
  try {
    const proc = Bun.spawn(["git", "status", "--short"], {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout] = await Promise.all([readText(proc.stdout), readText(proc.stderr)])
    if ((await proc.exited) !== 0) return "Git status unavailable."
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

async function appendDeliverable(task: Task, projectPath: string, exitCode: number) {
  const files = await gitStatus(projectPath)
  await appendEvent(task.id, {
    type: "deliverable",
    text: [
      "Final deliverable",
      "",
      `- Agent: ${task.agent}`,
      `- Model: ${task.model}`,
      `- Result: ${exitCode === 0 ? "completed" : `failed with exit code ${exitCode}`}`,
      "",
      "Files changed:",
      files,
    ].join("\n"),
  })
}

async function appendOutput(taskId: string, type: "runner" | "error", chunk: Uint8Array | undefined) {
  if (!chunk?.length) return
  const text = decoder().decode(chunk).trim()
  if (!text) return
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    await appendEvent(taskId, { type, text: line })
  }
}

async function readOutput(taskId: string, type: "runner" | "error", stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      await appendOutput(taskId, type, value)
    }
  } finally {
    reader.releaseLock()
  }
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
    await setTaskStatus(taskId, "running", `Runner started with ${task.agent} on ${task.model}`)
    await appendEvent(taskId, { type: "runner", text: `Workspace: ${project.path}` })

    const args = [
        bin,
        "run",
        task.prompt,
        "--format",
        "json",
        "--agent",
        task.agent,
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

    const proc = Bun.spawn(
      args,
      {
        cwd: project.path,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          OPENCODE_DISABLE_AUTOUPDATE: "1",
        },
      },
    )
    await patchTask(taskId, { runnerPid: proc.pid })

    await Promise.all([readOutput(taskId, "runner", proc.stdout), readOutput(taskId, "error", proc.stderr)])

    const exitCode = await proc.exited
    await patchTask(taskId, { runnerPid: undefined })
    await appendDeliverable(task, project.path, exitCode)
    if (exitCode === 0) {
      await setTaskStatus(taskId, "completed", "Task completed")
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
