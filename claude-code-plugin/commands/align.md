---
description: "Re-enable alignment or start tracking current work now"
allowed-tools: ["Bash(node:*)"]
---

Run this command and report the output to the user.

Use it to re-enable alignment after `/align-unlink`, or to start tracking manually before the first edit/write.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/alignment.mjs" cmd align "${CLAUDE_SESSION_ID}"
```
