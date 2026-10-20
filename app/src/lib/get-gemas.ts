/** Asks the open Wallet page to show its Get Gemas sheet (the top bar's Gemas pill on /wallet). */
const bus = new EventTarget();
const EVENT = "get-gemas";

export function requestGetGemas() {
  bus.dispatchEvent(new Event(EVENT));
}

export function onGetGemas(cb: () => void) {
  bus.addEventListener(EVENT, cb);
  return () => bus.removeEventListener(EVENT, cb);
}
