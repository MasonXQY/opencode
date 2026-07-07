import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

let cleanup: string | undefined

afterEach(async () => {
  if (cleanup) await rm(cleanup, { recursive: true, force: true })
  cleanup = undefined
  delete process.env.FACTORYSIGHT_REMOTE_DATA
})

test("gmailStatus returns connected metadata without exposing tokens", async () => {
  cleanup = await mkdtemp(join(tmpdir(), "factorysight-gmail-"))
  process.env.FACTORYSIGHT_REMOTE_DATA = cleanup
  const { gmailStatus, writeGmailToken } = await import(`./gmail-storage.ts?token=${Date.now()}`)

  await writeGmailToken({
    userId: "usr_1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    email: "mason@example.com",
  })

  expect(await gmailStatus("usr_1")).toMatchObject({
    connected: true,
    email: "mason@example.com",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
  })
  expect(JSON.stringify(await gmailStatus("usr_1"))).not.toContain("secret")
})
