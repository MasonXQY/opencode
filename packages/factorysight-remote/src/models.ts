import path from "node:path"
import { defaultModels, preferredDefaultModel } from "./shared"

let cached: { at: number; models: string[] } | undefined

function binaryPath() {
  return (
    process.env.FACTORYSIGHT_BIN ??
    (process.env.HOME ? path.join(process.env.HOME, ".opencode", "bin", "factorysight") : "factorysight")
  )
}

async function readStream(stream: ReadableStream<Uint8Array>) {
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

export async function availableModels(force = false) {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.models

  try {
    const proc = Bun.spawn([binaryPath(), "models"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    })
    const [stdout] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)])
    const exitCode = await proc.exited
    if (exitCode !== 0) return cached?.models ?? defaultModels

    const models = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes("/") && !line.includes(" "))
      .filter((line, index, items) => items.indexOf(line) === index)
      .sort((left, right) => left.localeCompare(right))

    const ordered = models.includes(preferredDefaultModel)
      ? [preferredDefaultModel, ...models.filter((model) => model !== preferredDefaultModel)]
      : models

    cached = { at: Date.now(), models: ordered.length ? ordered : defaultModels }
    return cached.models
  } catch {
    return cached?.models ?? defaultModels
  }
}
