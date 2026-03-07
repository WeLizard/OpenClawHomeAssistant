---
name: neiri-avatar-state
description: "Write compact Neiri avatar state for the Home Assistant Live2D panel"
metadata:
  { "openclaw": { "emoji": "🎭", "events": ["gateway:startup", "message:received", "message:sent", "command:reset"] } }
---

# Neiri Avatar State

Writes `/config/www/live2d/neiri-state.json` so the Home Assistant avatar can react to
OpenClaw events without changing OpenClaw core.
