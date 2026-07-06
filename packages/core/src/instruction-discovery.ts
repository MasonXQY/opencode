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
        update: (_previous, current) =>
          `These instructions replace all previously loaded instructions.\n\n${render(current)}`,
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

    const observe = Effect.fn("InstructionDiscovery.load")(function* (sessionID: SessionSchema.ID) {
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
      const files = [
        ...ambient,
        ...stored.flatMap((file) => {
          if (seen.has(file.path)) return []
          seen.add(file.path)
          return [new File({ path: file.path, content: file.content })]
        }),
      ]
      return files.length === 0 ? Instructions.empty : source(files)
    })

    const load = (sessionID: SessionSchema.ID) =>
      observe(sessionID).pipe(Effect.catch(() => Effect.succeed(source(Instructions.unavailable))))

    const admit = Effect.fn("InstructionDiscovery.discover")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly assistantMessageID: SessionMessage.ID
      readonly paths: ReadonlyArray<string>
    }) {
      const paths = Array.dedupe(yield* Effect.forEach(input.paths, fs.resolve))
      if (paths.length === 0) return
      const existing = new Set(
        (
          yield* db
            .select({ path: InstructionFileTable.path })
            .from(InstructionFileTable)
            .where(eq(InstructionFileTable.session_id, input.sessionID))
            .all()
            .pipe(Effect.orDie)
        ).map((row) => row.path),
      )
      const files = yield* Effect.forEach(
        paths.filter((path) => !existing.has(AbsolutePath.make(path))),
        (path) =>
          fs.readFileStringSafe(path).pipe(
            Effect.map((content) =>
              content === undefined
                ? undefined
                : { path: AbsolutePath.make(path), content },
            ),
          ),
        { concurrency: "unbounded" },
      )
      const readable = files.filter(
        (file): file is { path: AbsolutePath; content: string } => file !== undefined,
      )
      if (readable.length === 0) return
      yield* events.publish(SessionEvent.InstructionsDiscovered, {
        sessionID: input.sessionID,
        assistantMessageID: input.assistantMessageID,
        location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
        files: readable,
      })
    })

    const discover = (input: Parameters<typeof admit>[0]) => lock.withPermit(admit(input))

    return Service.of({ load, discover })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, FSUtil.node, Global.node, Location.node],
})

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}
