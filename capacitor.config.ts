import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.manzelh.app",
  appName: "منزل H",
  webDir: "dist",
  bundledWebRuntime: false,
  android: {
    allowMixedContent: true,
    backgroundColor: "#f5f5f2"
  }
};

export default config;
