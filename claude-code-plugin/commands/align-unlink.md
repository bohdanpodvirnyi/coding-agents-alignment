---
description: "Stop alignment for this session"
allowed-tools: ["Bash(node:*)"]
---

Run this command and report the output to the user:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/alignment.mjs" cmd unlink "${CLAUDE_SESSION_ID}"
```
