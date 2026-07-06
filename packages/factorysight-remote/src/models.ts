import path from "node:path"
import { spawn } from "node:child_process"
import { defaultModels, preferredDefaultModel } from "./shared"

let cached: { at: number; models: string[] } | undefined

function binaryPath() {
  return (
    process.env.FACTORYSIGHT_BIN ??
    (process.env.HOME ? path.join(process.env.HOME, ".opencode", "bin", "factorysight") : "factorysight")
  )
}

async function readStream(stream: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true })
  }
  return text
}

export async function availableModels(force = false) {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.models

  try {
    const proc = spawn(binaryPath(), ["models"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    })
    const [stdout, exitCode] = await Promise.all([
      proc.stdout ? readStream(proc.stdout) : Promise.resolve(""),
      new Promise<number | null>((resolve) => proc.on("close", resolve)),
      proc.stderr ? readStream(proc.stderr) : Promise.resolve(""),
    ])
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
