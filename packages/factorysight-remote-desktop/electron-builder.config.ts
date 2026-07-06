import type { Configuration } from "electron-builder"

const config: Configuration = {
  appId: "ai.factorysight.remote.desktop",
  productName: "FactorySight Remote",
  artifactName: "FactorySight-Remote-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "../desktop/resources",
  },
  files: ["out/**/*"],
  extraResources: [
    {
      from: "../factorysight-remote/dist/client",
      to: "factorysight-remote-client",
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: "../desktop/resources/icons/icon.icns",
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: false,
  },
}

export default config
