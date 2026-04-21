// Shared lazy loader for Tauri runtime APIs. In the web/PWA build the
// dynamic imports never resolve — every helper short-circuits via isTauri()
// so callers can safely await them from any code path.

export const isTauri = () =>
  typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

let corePromise = null;
let eventPromise = null;
let windowPromise = null;

export function loadCore() {
  if (!isTauri()) return Promise.resolve(null);
  if (!corePromise) corePromise = import("@tauri-apps/api/core");
  return corePromise;
}

export function loadEvent() {
  if (!isTauri()) return Promise.resolve(null);
  if (!eventPromise) eventPromise = import("@tauri-apps/api/event");
  return eventPromise;
}

export function loadWindow() {
  if (!isTauri()) return Promise.resolve(null);
  if (!windowPromise) windowPromise = import("@tauri-apps/api/window");
  return windowPromise;
}

export async function invoke(command, args) {
  const core = await loadCore();
  if (!core) return null;
  return core.invoke(command, args);
}

export async function listen(event, handler) {
  const evt = await loadEvent();
  if (!evt) return () => {};
  return evt.listen(event, handler);
}
