import { randomUUID } from "node:crypto"
import path from "node:path"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import type { GmailStatus } from "./shared"

const defaultDataDir = path.join(process.env.HOME ?? process.cwd(), ".factorysight-remote")
const dataDir = process.env.FACTORYSIGHT_REMOTE_DATA ?? defaultDataDir
const gmailDir = path.join(dataDir, "gmail")

type GmailTokenRecord = {
  userId: string
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
  email?: string
  updatedAt: string
}

type GmailOAuthState = {
  userId: string
  state: string
  createdAt: string
}

function tokenPath(userId: string) {
  return path.join(gmailDir, `${userId}.json`)
}

function statePath(state: string) {
  return path.join(gmailDir, "oauth-state", `${state}.json`)
}

async function ensureGmailDir() {
  await mkdir(path.join(gmailDir, "oauth-state"), { recursive: true, mode: 0o700 })
}

export async function createGmailOAuthState(userId: string) {
  await ensureGmailDir()
  const state = randomUUID()
  const record: GmailOAuthState = { userId, state, createdAt: new Date().toISOString() }
  await writeFile(statePath(state), JSON.stringify(record, null, 2), { mode: 0o600 })
  return state
}

export async function consumeGmailOAuthState(state: string) {
  await ensureGmailDir()
  const filepath = statePath(state)
  const record = JSON.parse(await readFile(filepath, "utf8")) as GmailOAuthState
  await rm(filepath, { force: true })
  const ageMs = Date.now() - Date.parse(record.createdAt)
  if (ageMs > 10 * 60 * 1000) throw new Error("Gmail authorization state expired")
  return record
}

export async function readGmailToken(userId: string) {
  try {
    return JSON.parse(await readFile(tokenPath(userId), "utf8")) as GmailTokenRecord
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

export async function writeGmailToken(record: Omit<GmailTokenRecord, "updatedAt">) {
  await ensureGmailDir()
  const next: GmailTokenRecord = { ...record, updatedAt: new Date().toISOString() }
  await writeFile(tokenPath(record.userId), JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}

export async function clearGmailToken(userId: string) {
  await rm(tokenPath(userId), { force: true })
}

export async function gmailStatus(userId: string): Promise<GmailStatus> {
  const token = await readGmailToken(userId)
  if (!token) return { connected: false }
  return {
    connected: true,
    email: token.email,
    scope: token.scope,
    updatedAt: token.updatedAt,
  }
}
