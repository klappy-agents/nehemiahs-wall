import { DurableObject } from "cloudflare:workers";
import { newRoom, view, act } from "./core/game.js";
import { checkStateSize, decideClaim, effectiveMaxRooms } from "./core/limits.js";

// One Durable Object per room: the single writer. State is plain tables; a save is the snapshot.
// Rooms are created only by an explicit join, and only if the per-environment registry admits them.
export class Room extends DurableObject {
  async load(id, { create = false } = {}) {
    const state = await this.ctx.storage.get("state");
    if (state) return { state };
    if (!create) return { error: "room_not_found" };
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
    const claim = await registry.claim(id);
    if (!claim.ok) return { error: claim.error };
    const fresh = newRoom({ id, seed: hashSeed(id), now: Date.now() });
    await this.ctx.storage.put("state", fresh);
    return { state: fresh };
  }

  async look(id, seat, grant) {
    const { state, error } = await this.load(id);
    return error ? { error } : view(state, seat, grant);
  }

  async act(id, action, grant) {
    const { state, error } = await this.load(id, { create: action?.type === "join" });
    if (error) return { ok: false, error };
    const res = act(state, action, grant, Date.now());
    if (!res.ok) return { ok: false, error: res.error, rev: state.rev };
    const size = checkStateSize(res.state);
    if (!size.ok) return { ok: false, error: size.error, rev: state.rev };
    await this.ctx.storage.put("state", res.state);
    return { ok: true, view: view(res.state, action.seat, grant) };
  }
}

// One registry per environment (each env is its own Worker + DO namespace). Single-threaded DO → the
// count check and insert are atomic. Decision logic lives in core/limits.js.
export class RoomRegistry extends DurableObject {
  async claim(id) {
    const exists = Boolean(await this.ctx.storage.get(`room:${id}`));
    const count = (await this.ctx.storage.get("count")) ?? 0;
    const d = decideClaim({ exists, count, max: effectiveMaxRooms(this.env) });
    if (d.ok && d.create) {
      await this.ctx.storage.put({ [`room:${id}`]: Date.now(), count: count + 1 });
    }
    return d.ok ? { ok: true } : { ok: false, error: d.error };
  }
}

function hashSeed(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
