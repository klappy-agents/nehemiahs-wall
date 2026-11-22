import { DurableObject } from "cloudflare:workers";
import { newRoom, view, act } from "./core/game.js";
import { checkStateSize, decideClaim, effectiveMaxRooms } from "./core/limits.js";
import { RoomCore, RegistryCore } from "./core/caps.js";

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

  // ── AUTH_MODE "capability" (D10 agent-first). Logic lives in core/caps.js; these are thin DO entry points.
  core() {
    const release = (id) => this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry")).release(id);
    return new RoomCore(this.ctx.storage, { release });
  }
  async capInit(id) {
    return this.core().init(id, hashSeed(id));
  }
  async capCall(token, req, ip) {
    return this.core().call(token, req, ip);
  }
  async capClaim(code, ip) {
    return this.core().claim(code, ip);
  }
  async alarm() {
    await this.core().alarm();
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

  // Capability mode: the registry mints the room id and applies the create rate limits + room cap.
  async capCreate(ip) {
    return new RegistryCore(this.ctx.storage, { max: effectiveMaxRooms(this.env) }).create(ip);
  }
  async release(id) {
    return new RegistryCore(this.ctx.storage, { max: effectiveMaxRooms(this.env) }).release(id);
  }
}

function hashSeed(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
