---
description: "Re-sync tracked item with GitHub"
allowed-tools: ["Bash(node:*)"]
---

Run this command and report the output to the user:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" cmd resync "${CLAUDE_SESSION_ID}"
```
