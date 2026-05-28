export function fireLifecycleEvent(type: string) {
  window.dispatchEvent(new Event(type));
}

export function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  window.dispatchEvent(new Event("visibilitychange"));
}

export function firePageShow() {
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
}
