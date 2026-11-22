import { route } from "./router.js";
export { Room, RoomRegistry } from "./room.js";

export default {
  fetch: (request, env) => route(request, env),
};
