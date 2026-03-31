---
description: "Re-enable tracking after /track-unlink"
allowed-tools: ["Bash(node:*)"]
---

Run this command and report the output to the user:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" cmd track "${CLAUDE_SESSION_ID}"
```
