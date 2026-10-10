/**
 * Stories never touch devnet, Hoodi, the rollup or the app's API routes. Any fetch or WebSocket
 * that is not a local static file fails fast, so components show their offline/error state instead
 * of hanging. Mock the hook (see app/docs/storybook.md) when a story needs data from it.
 */
const LOCAL_STATIC = /^\/(art|brand|icons|_next|@|node_modules|sb-|favicon|.*\.(?:webp|avif|png|svg|jpg|glb|webm|mp4|json)$)/;

export function blockNetwork() {
  if (typeof window === "undefined" || (window as { __tesoroOffline?: boolean }).__tesoroOffline) return;
  (window as { __tesoroOffline?: boolean }).__tesoroOffline = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.origin === location.origin && LOCAL_STATIC.test(url.pathname)) return realFetch(input, init);
    return Promise.reject(new TypeError(`Offline in Storybook: ${url.origin === location.origin ? url.pathname : url.origin}`));
  };
  class OfflineSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 3;
    url: string;
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    constructor(url: string | URL) {
      super();
      this.url = String(url);
    }
    send() {}
    close() {}
  }
  window.WebSocket = OfflineSocket as unknown as typeof WebSocket;
}
