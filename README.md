# 🧱🎺 Nehemiah's Wall

A real-time, Tetris-style co-op Bible game: you build 🛠️, your AI watchman keeps watch 👀 (Neh 4–6). Cut stones fall, finished courses lock as wall, and you have 52 days 🗓️ and one team 🤝.

🌐 browser + 🔌 MCP · ☁️ Cloudflare Workers + Durable Objects

- Spec: [docs/SPEC.md](docs/SPEC.md) · Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Ticket: [klappy/kitchen rail ticket](https://github.com/klappy/kitchen/blob/main/rail/2-cooking/2026-11-21-nehemiahs-wall-coop-game/TICKET.md)

- Security: [docs/SECURITY.md](docs/SECURITY.md) (auth fails closed, role capabilities, room bounds) · Receipts: [docs/GATE-RECEIPTS.md](docs/GATE-RECEIPTS.md)

```
npm ci && npm test           # node:test — rules core, auth, capabilities, limits
npx wrangler dev --env dev   # local only; tool routes 401 unless a key is set
# no-key local play: cp .dev.vars.example .dev.vars   (ENVIRONMENT=local + AUTH_MODE=open; untracked)
```

**Status:** M1 scaffold. Nothing is deployed; there is no live URL yet. Deploys go through Workers Builds (dev → staging → production, production only on the captain's explicit go).
