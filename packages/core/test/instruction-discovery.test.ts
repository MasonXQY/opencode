import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import fs from "fs/promises"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { InstructionDiscovery } from "@opencode-ai/core/instruction-discovery"
import { Instructions } from "@opencode-ai/core/instructions"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { InstructionFileTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const instructionLayer = (input: {
  config: string
  locationServiceLayer: Layer.Layer<Location.Service>
  filesystemLayer?: Layer.Layer<FSUtil.Service>
}) =>
  AppNodeBuilder.build(InstructionDiscovery.node, [
    [Global.node, Global.layerWith({ config: input.config })],
    [Location.node, input.locationServiceLayer],
    ...(input.filesystemLayer ? [[FSUtil.node, input.filesystemLayer] as const] : []),
  ])

const sessionID = SessionV2.ID.make("ses_instruction_discovery_test")
const assistantMessageID = SessionMessage.ID.make("msg_instruction_discovery")

const durableLayer = (input: { config: string; directory: string }) =>
  AppNodeBuilder.build(LayerNode.group([Database.node, InstructionDiscovery.node, SessionProjector.node]), [
    [Global.node, Global.layerWith({ config: input.config })],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(input.directory) }))),
    ],
  ])

const withDurableDiscovery = <A, E, R>(
  run: (input: { directory: string; config: string; sessionID: SessionV2.ID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) => {
      const directory = path.join(tmp.path, "project")
      const config = path.join(tmp.path, "global")
      return Effect.promise(() =>
        Promise.all([fs.mkdir(directory, { recursive: true }), fs.mkdir(config, { recursive: true })]),
      ).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const sessionID = SessionV2.ID.create()
            const { db } = yield* Database.Service
            yield* db
              .insert(ProjectTable)
              .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(SessionTable)
              .values({
                id: sessionID,
                project_id: Project.ID.global,
                slug: sessionID,
                directory: AbsolutePath.make(directory),
                title: "instruction discovery",
                version: "test",
              })
              .run()
              .pipe(Effect.orDie)
            const encoded = Schema.encodeSync(SessionMessage.Message)(
              SessionMessage.Assistant.make({
                id: assistantMessageID,
                type: "assistant",
                agent: "build",
                model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
                content: [],
                time: { created: DateTime.makeUnsafe(0) },
              }),
            )
            const { id: _, type, ...data } = encoded
            yield* db
              .insert(SessionMessageTable)
              .values({ id: assistantMessageID, session_id: sessionID, type, seq: 1, time_created: 0, data })
              .run()
              .pipe(Effect.orDie)
            return yield* run({ directory, config, sessionID })
          }),
        ),
        Effect.provide(durableLayer({ directory, config })),
      )
    }),
  )

describe("InstructionDiscovery", () => {
  it.live("loads global and upward project AGENTS.md files as one aggregate context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const directory = path.join(project, "packages", "core")
          const outside = path.join(tmp.path, "AGENTS.md")
          const globalFile = path.join(global, "AGENTS.md")
          const projectFile = path.join(project, "AGENTS.md")
          const packageFile = path.join(directory, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(outside, "outside")
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(packageFile, "package")
          })

          const load = InstructionDiscovery.Service.pipe(
            Effect.flatMap((service) => service.load(sessionID)),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(directory) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )

          const initialized = yield* Instructions.initialize(yield* load)
          expect(initialized.text).toBe(
            [
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${packageFile}\npackage`,
              `Instructions from: ${projectFile}\nproject`,
            ].join("\n\n"),
          )
          expect(initialized.text).not.toContain("outside")

          yield* Effect.promise(() => fs.writeFile(packageFile, "changed"))
          expect(yield* Instructions.reconcile(yield* load, initialized.applied)).toMatchObject({
            _tag: "Updated",
            text: `The instructions from ${packageFile} changed to:\nchanged`,
          })

          yield* Effect.promise(() => fs.rm(packageFile))
          const partial = yield* Instructions.reconcile(yield* load, initialized.applied)
          expect(partial).toEqual({
            _tag: "Updated",
            text: `Instructions from the following files no longer apply: ${packageFile}.`,
            applied: expect.any(Object),
          })

          yield* Effect.promise(() => Promise.all([fs.rm(globalFile), fs.rm(projectFile)]))
          expect(yield* Instructions.reconcile(yield* load, initialized.applied)).toEqual({
            _tag: "Updated",
            text: "Previously loaded instructions no longer apply.",
            applied: {},
          })
        }),
      ),
    ),
  )

  it.live("keeps an empty AGENTS.md as available context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "AGENTS.md")
          yield* Effect.promise(() => fs.writeFile(file, ""))
          const context = yield* InstructionDiscovery.Service.pipe(
            Effect.flatMap((service) => service.load(sessionID)),
            Effect.provide(
              instructionLayer({
                config: path.join(tmp.path, "global"),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                ),
              }),
            ),
          )

          expect((yield* Instructions.initialize(context)).text).toBe(`Instructions from: ${file}\n`)
        }),
      ),
    ),
  )

  it.live("stores discovered file content at admission time", () =>
    withDurableDiscovery(({ directory, sessionID }) =>
      Effect.gen(function* () {
        const file = path.join(directory, "src", "AGENTS.md")
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "frozen"))
        const discovery = yield* InstructionDiscovery.Service

        yield* discovery.discover({ sessionID, assistantMessageID, paths: [file] })
        yield* Effect.promise(() => fs.writeFile(file, "changed"))

        const database = yield* Database.Service
        expect(yield* database.db.select().from(InstructionFileTable).all().pipe(Effect.orDie)).toMatchObject([
          { session_id: sessionID, path: file, content: "frozen" },
        ])
      }),
    ),
  )

  it.live("re-reads discovered files so mid-session edits reach the model", () =>
    withDurableDiscovery(({ directory, sessionID }) =>
      Effect.gen(function* () {
        const file = path.join(directory, "src", "AGENTS.md")
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "frozen"))
        const discovery = yield* InstructionDiscovery.Service
        yield* discovery.discover({ sessionID, assistantMessageID, paths: [file] })

        const initialized = yield* Instructions.initialize(yield* discovery.load(sessionID))
        expect(initialized.text).toContain(`Instructions from: ${file}\nfrozen`)

        yield* Effect.promise(() => fs.writeFile(file, "edited"))
        expect(yield* Instructions.reconcile(yield* discovery.load(sessionID), initialized.applied)).toMatchObject({
          _tag: "Updated",
          text: `The instructions from ${file} changed to:\nedited`,
        })
      }),
    ),
  )

  it.live("falls back to frozen content when a discovered file disappears", () =>
    withDurableDiscovery(({ directory, sessionID }) =>
      Effect.gen(function* () {
        const file = path.join(directory, "src", "AGENTS.md")
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "frozen"))
        const discovery = yield* InstructionDiscovery.Service
        yield* discovery.discover({ sessionID, assistantMessageID, paths: [file] })
        yield* Effect.promise(() => fs.rm(file))

        const initialized = yield* Instructions.initialize(yield* discovery.load(sessionID))
        expect(initialized.text).toContain(`Instructions from: ${file}\nfrozen`)
      }),
    ),
  )

  it.live("deduplicates repeated and parallel discovery", () =>
    withDurableDiscovery(({ directory, sessionID }) =>
      Effect.gen(function* () {
        const first = path.join(directory, "one", "AGENTS.md")
        const second = path.join(directory, "two", "AGENTS.md")
        yield* Effect.promise(() =>
          Promise.all([
            fs.mkdir(path.dirname(first), { recursive: true }).then(() => fs.writeFile(first, "one")),
            fs.mkdir(path.dirname(second), { recursive: true }).then(() => fs.writeFile(second, "two")),
          ]),
        )
        const discovery = yield* InstructionDiscovery.Service

        yield* Effect.all(
          [
            discovery.discover({ sessionID, assistantMessageID, paths: [first, first, second] }),
            discovery.discover({ sessionID, assistantMessageID, paths: [second, first] }),
            discovery.discover({ sessionID, assistantMessageID, paths: [first] }),
          ],
          { concurrency: "unbounded" },
        )
        yield* discovery.discover({ sessionID, assistantMessageID, paths: [first, second, first] })

        const database = yield* Database.Service
        const rows = yield* database.db
          .select({ path: InstructionFileTable.path })
          .from(InstructionFileTable)
          .all()
          .pipe(Effect.orDie)
        expect(rows.map((row) => row.path).sort()).toEqual([AbsolutePath.make(first), AbsolutePath.make(second)].sort())
      }),
    ),
  )

  it.live("loads ambient and stored instructions together", () =>
    withDurableDiscovery(({ directory, sessionID }) =>
      Effect.gen(function* () {
        const ambient = path.join(directory, "AGENTS.md")
        const stored = path.join(directory, "src", "AGENTS.md")
        yield* Effect.promise(() => fs.writeFile(ambient, "ambient"))
        yield* Effect.promise(() => fs.mkdir(path.dirname(stored), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(stored, "stored"))
        const discovery = yield* InstructionDiscovery.Service

        yield* discovery.discover({ sessionID, assistantMessageID, paths: [stored] })

        expect((yield* Instructions.initialize(yield* discovery.load(sessionID))).text).toBe(
          `Instructions from: ${ambient}\nambient\n\nInstructions from: ${stored}\nstored`,
        )
      }),
    ),
  )

  it.live("does not emit synthetic messages during discovery", () =>
    withDurableDiscovery(({ directory, sessionID }) =>
      Effect.gen(function* () {
        const file = path.join(directory, "src", "AGENTS.md")
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "stored"))

        const discovery = yield* InstructionDiscovery.Service
        yield* discovery.discover({ sessionID, assistantMessageID, paths: [file] })

        const database = yield* Database.Service
        const messages = yield* database.db.select().from(SessionMessageTable).all().pipe(Effect.orDie)
        expect(messages.filter((message) => message.type === "synthetic")).toEqual([])
      }),
    ),
  )

  it.effect("preserves admitted instructions while observation is unavailable", () =>
    Effect.gen(function* () {
      const failingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({ ...fs, up: () => Effect.fail(new FSUtil.FileSystemError({ method: "up" })) }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* InstructionDiscovery.Service.pipe(
        Effect.flatMap((service) => service.load(sessionID)),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: failingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* Instructions.reconcile(context, {
          "core/instructions": {
            value: [{ path: "/repo/AGENTS.md", content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("preserves admitted instructions when a discovered file disappears before read", () =>
    Effect.gen(function* () {
      const file = AbsolutePath.make("/repo/AGENTS.md")
      const racingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: () => Effect.succeed([file]),
              readFileStringSafe: () => Effect.succeed(undefined),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* InstructionDiscovery.Service.pipe(
        Effect.flatMap((service) => service.load(sessionID)),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: racingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* Instructions.reconcile(context, {
          "core/instructions": {
            value: [{ path: file, content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("canonicalizes upward discovery boundaries", () =>
    Effect.gen(function* () {
      let observed: { targets: string[]; start: string; stop?: string } | undefined
      const observingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) =>
                Effect.sync(() => {
                  observed = options
                  return []
                }),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      yield* InstructionDiscovery.Service.pipe(
        Effect.flatMap((service) => service.load(sessionID)),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make("/repo/") }, { projectDirectory: AbsolutePath.make("/repo") }),
              ),
            ),
          }),
        ),
      )

      expect(observed).toEqual({
        targets: ["AGENTS.md"],
        start: FSUtil.resolve("/repo"),
        stop: FSUtil.resolve("/repo"),
      })
    }),
  )

  it.effect("honors the project instruction opt-out", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
      let scanned = false
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"

      yield* InstructionDiscovery.Service.pipe(
        Effect.flatMap((service) => service.load(sessionID)),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
            else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previous
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  it.effect("does not discover project instructions outside the canonical project root", () =>
    Effect.gen(function* () {
      let scanned = false
      yield* InstructionDiscovery.Service.pipe(
        Effect.flatMap((service) => service.load(sessionID)),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/outside") },
                  { projectDirectory: AbsolutePath.make("/repo") },
                ),
              ),
            ),
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )
})
