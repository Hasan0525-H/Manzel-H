import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.manzelh.app",
  appName: "Manzel H",
  webDir: "dist",
  bundledWebRuntime: false,
  android: {
    allowMixedContent: true,
    backgroundColor: "#111a29"
  }
};

export default config;
