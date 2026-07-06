export * as InstructionDiscovery from "./instruction-discovery"

import { asc, eq } from "drizzle-orm"
import { Array, Context, Effect, Layer, Schema, Semaphore } from "effect"
import { isAbsolute, join, relative, sep } from "path"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Instructions } from "./instructions/index"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { SessionSchema } from "./session/schema"
import { InstructionFileTable } from "./session/sql"
import { SessionEvent } from "./session/event"
import { SessionMessage } from "./session/message"

class File extends Schema.Class<File>("InstructionDiscovery.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = Instructions.Key.make("core/instructions")

export interface Interface {
  readonly load: (sessionID: SessionSchema.ID) => Effect.Effect<Instructions.Instructions>
  readonly discover: (input: {
    readonly sessionID: SessionSchema.ID
    readonly assistantMessageID: SessionMessage.ID
    readonly paths: ReadonlyArray<string>
  }) => Effect.Effect<void, FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/InstructionDiscovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const lock = Semaphore.makeUnsafe(1)

    const source = (value: ReadonlyArray<File> | Instructions.Unavailable) =>
      Instructions.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update,
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const observeAmbient = Effect.fn("InstructionDiscovery.observeAmbient")(function* () {
      const start = yield* fs.resolve(location.directory)
      const stop = yield* fs.resolve(location.project.directory)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const discovered = new Set(
        yield* Effect.forEach(
          Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !insideProject
            ? []
            : yield* fs.up({
                targets: ["AGENTS.md"],
                start,
                stop,
              }),
          fs.resolve,
        ),
      )
      const paths = Array.dedupe([yield* fs.resolve(join(global.config, "AGENTS.md")), ...discovered])
      const files = yield* Effect.forEach(
        paths,
        (path) =>
          fs
            .readFileStringSafe(path)
            .pipe(
              Effect.map((content) =>
                content === undefined ? undefined : new File({ path: AbsolutePath.make(path), content }),
              ),
            ),
        { concurrency: "unbounded" },
      )
      if (files.some((file, index) => file === undefined && discovered.has(paths[index])))
        return Instructions.unavailable
      return files.filter((file): file is File => file !== undefined)
    })

    const observe = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const ambient = yield* observeAmbient()
      if (ambient === Instructions.unavailable) return source(ambient)
      const stored = yield* db
        .select({ path: InstructionFileTable.path, content: InstructionFileTable.content })
        .from(InstructionFileTable)
        .where(eq(InstructionFileTable.session_id, sessionID))
        .orderBy(
          asc(InstructionFileTable.discovered_seq),
          asc(InstructionFileTable.position),
          asc(InstructionFileTable.path),
        )
        .all()
        .pipe(Effect.orDie)
      const seen = new Set(ambient.map((file) => file.path))
      // Discovered files are re-observed live so mid-session edits reach the model;
      // the frozen discovery content only stands in when the file cannot be read.
      const discovered = yield* Effect.forEach(
        stored.filter((file) => !seen.has(file.path)),
        (file) =>
          fs
            .readFileStringSafe(file.path)
            .pipe(Effect.map((content) => new File({ path: file.path, content: content ?? file.content }))),
        { concurrency: "unbounded" },
      )
      const files = [...ambient, ...discovered]
      return files.length === 0 ? Instructions.empty : source(files)
    })

    const load = Effect.fn("InstructionDiscovery.load")(function* (sessionID: SessionSchema.ID) {
      return yield* observe(sessionID).pipe(Effect.catch(() => Effect.succeed(source(Instructions.unavailable))))
    })

    const admit = Effect.fnUntraced(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly assistantMessageID: SessionMessage.ID
      readonly paths: ReadonlyArray<string>
    }) {
      const paths = Array.dedupe(yield* Effect.forEach(input.paths, fs.resolve))
      if (paths.length === 0) return
      const existing = new Set(
        (yield* db
          .select({ path: InstructionFileTable.path })
          .from(InstructionFileTable)
          .where(eq(InstructionFileTable.session_id, input.sessionID))
          .all()
          .pipe(Effect.orDie)).map((row) => row.path),
      )
      const files = yield* Effect.forEach(
        paths.filter((path) => !existing.has(AbsolutePath.make(path))),
        (path) =>
          fs
            .readFileStringSafe(path)
            .pipe(
              Effect.map((content) => (content === undefined ? undefined : { path: AbsolutePath.make(path), content })),
            ),
        { concurrency: "unbounded" },
      )
      const readable = files.filter((file): file is { path: AbsolutePath; content: string } => file !== undefined)
      if (readable.length === 0) return
      yield* events.publish(SessionEvent.InstructionsDiscovered, {
        sessionID: input.sessionID,
        assistantMessageID: input.assistantMessageID,
        location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
        files: readable,
      })
    })

    const discover = Effect.fn("InstructionDiscovery.discover")(function* (input: Parameters<typeof admit>[0]) {
      yield* lock.withPermit(admit(input))
    })

    return Service.of({ load, discover })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, FSUtil.node, Global.node, Location.node],
})

function render(files: ReadonlyArray<File>) {
  return files.map(renderFile).join("\n\n")
}

function renderFile(file: File) {
  return `Instructions from: ${file.path}\n${file.content}`
}

// Per-file deltas keep chronological updates small as discoveries accumulate. A
// pure reordering has no per-file story to tell, so it restates the full set.
function update(previous: ReadonlyArray<File>, current: ReadonlyArray<File>) {
  const diff = Instructions.diffByKey(
    previous,
    current,
    (file) => file.path,
    (before, after) => before.content !== after.content,
  )
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0)
    return ["These instructions replace all previously loaded instructions.", render(current)].join("\n\n")
  return [
    ...diff.added.map(renderFile),
    ...diff.changed.map(
      (change) => `The instructions from ${change.current.path} changed to:\n${change.current.content}`,
    ),
    ...(diff.removed.length === 0
      ? []
      : [
          `Instructions from the following files no longer apply: ${diff.removed.map((file) => file.path).join(", ")}.`,
        ]),
  ].join("\n\n")
}
