import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createRelayHandler } from "./server/http.mjs";
import { RelayStore } from "./server/state.mjs";

export default definePluginEntry({
  id: "temporary-powershell-relay",
  name: "Temporary PowerShell Relay",
  description: "Authenticated bounded or explicitly trusted PowerShell support sessions without a Windows OpenClaw node.",
  register(api) {
    const store = new RelayStore();
    void store.pruneExpired();
    api.registerHttpRoute({
      path: "/temporary-powershell",
      match: "prefix",
      auth: "plugin",
      handler: createRelayHandler({ store }),
    });
  },
});
