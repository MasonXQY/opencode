import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { serve } from "@hono/node-server"
import { app, BrowserWindow, Menu, shell } from "electron"

let remoteServer: ReturnType<typeof serve> | undefined
let mainWindow: BrowserWindow | undefined

function findFreePort() {
  return new Promise<number>((resolvePort, reject) => {
    const probe = createServer()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("Unable to allocate a local port for FactorySight Remote"))
        return
      }
      const port = address.port
      probe.close(() => resolvePort(port))
    })
  })
}

function remoteClientDir() {
  if (app.isPackaged) return join(process.resourcesPath, "factorysight-remote-client")
  return resolve(app.getAppPath(), "../factorysight-remote/dist/client")
}

async function startRemoteServer() {
  const port = Number(process.env.FACTORYSIGHT_REMOTE_DESKTOP_PORT ?? (await findFreePort()))
  process.env.FACTORYSIGHT_REMOTE_HOST = "127.0.0.1"
  process.env.FACTORYSIGHT_REMOTE_PORT = String(port)
  process.env.FACTORYSIGHT_REMOTE_CLIENT_DIR = remoteClientDir()
  process.env.FACTORYSIGHT_REMOTE_DATA ??= join(app.getPath("userData"), "data")
  process.env.OPENCODE_DISABLE_AUTOUPDATE = "1"

  const { app: remoteApp } = await import("../../../factorysight-remote/src/server")
  remoteServer = serve({
    fetch: remoteApp.fetch,
    hostname: "127.0.0.1",
    port,
  })
  return `http://127.0.0.1:${port}`
}

function createWindow(url: string) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "FactorySight Remote",
    backgroundColor: "#010102",
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 18 },
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1:")) return { action: "allow" }
    void shell.openExternal(url)
    return { action: "deny" }
  })
  void mainWindow.loadURL(url)
}

function createMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "FactorySight Remote",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
      },
    ]),
  )
}

app.setName("FactorySight Remote")
app.setAppUserModelId("ai.factorysight.remote.desktop")
app.setPath("userData", join(app.getPath("appData"), "ai.factorysight.remote.desktop"))

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow) mainWindow.show()
})

app.on("before-quit", () => {
  remoteServer?.close()
})

app
  .whenReady()
  .then(async () => {
    createMenu()
    const url = await startRemoteServer()
    createWindow(url)
  })
  .catch((error) => {
    console.error("FactorySight Remote desktop failed to start", error)
    app.exit(1)
  })
