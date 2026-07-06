import { Effect } from "effect"
import { OpenCode as EffectOpenCode, type AppApi as EffectApi } from "../src/effect"

type EffectClient = Effect.Success<ReturnType<typeof EffectOpenCode.make>>
type PromiseClient = ReturnType<typeof import("../src/promise").OpenCode.make>

declare const effectClient: EffectClient
declare const promiseClient: PromiseClient

const effectApi: EffectApi<unknown> = effectClient

declare const sessionID: Parameters<typeof effectApi.session.instructions.list>[0]["sessionID"]

const effectList: Effect.Effect<
  ReadonlyArray<{ readonly key: string; readonly value: unknown }>,
  unknown
> = effectApi.session.instructions.list({ sessionID })
const effectPut: Effect.Effect<void, unknown> = effectApi.session.instructions.put({
  sessionID,
  key: "review-notes",
  value: { text: "Check the diff" },
})
const effectRemove: Effect.Effect<void, unknown> = effectApi.session.instructions.remove({
  sessionID,
  key: "review-notes",
})

const promiseList: Promise<ReadonlyArray<{ readonly key: string; readonly value: unknown }>> =
  promiseClient.session.instructions.list({ sessionID: "ses_test" })
const promisePut: Promise<void> = promiseClient.session.instructions.put({
  sessionID: "ses_test",
  key: "review-notes",
  value: { text: "Check the diff" },
})
const promiseRemove: Promise<void> = promiseClient.session.instructions.remove({
  sessionID: "ses_test",
  key: "review-notes",
})

void [effectList, effectPut, effectRemove, promiseList, promisePut, promiseRemove]
