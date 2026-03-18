---
name: neiri-avatar-state
description: "Write compact Neiri avatar state for the Home Assistant Live2D panel"
metadata:
  { "openclaw": { "emoji": "🎭", "events": ["gateway:startup", "message:received", "message:sent", "command:reset"] } }
---

# Neiri Avatar State

Writes the assistant speech-state bridge for the Home Assistant avatar and `Kiosk Scene`
runtime without changing OpenClaw core.

Current responsibilities:
- mirror assistant runtime state to `/config/www/live2d/neiri-state.json`
- mirror scene control to `/config/www/live2d/neiri-control.json`
- publish the same state/control into Home Assistant helper entities when configured
- strip inline directives such as `[emotion:...]`, `[cue:...]`, `[page:...]`, `[preset:...]`
  from visible speech while still applying them to the scene/avatar contract
