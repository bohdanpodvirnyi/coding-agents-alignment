---
description: "Stop tracking for this session"
allowed-tools: ["Bash(node:*)"]
---

Run this command and report the output to the user:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" cmd unlink "${CLAUDE_SESSION_ID}"
```
