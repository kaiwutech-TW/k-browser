// @ts-check
// Which CDP methods a client may send inside a session (root or child): an exact allowlist, default deny.
//
// A session is scoped to one owned tab, but many CDP methods reach past it: cookies for any site, the whole
// profile's storage, files on disk, blob handles of the browser context, the browser itself. Whole domains are
// never allowed: a method Chrome adds later gets no permission until someone reviews it and adds it here.
// Chrome's own restrictions on chrome.debugger are not treated as our protection.
//
// Sources for the list: Kav's literal CDP calls (kfw/*.py at 53ec106; it builds no method names dynamically) and
// what the SDK needs. Browser-level methods are not listed: the relay emulates a fixed set, refusing the rest.

const URL_SCHEMES = ['http://', 'https://', 'about:blank', 'data:'];

/** Navigation targets: the web only. file:// would let Runtime.evaluate read local files; chrome:// is the browser's UI.
 * @param {unknown} url @returns {string | null} */
export function checkUrl(url) {
  if (typeof url !== 'string' || !URL_SCHEMES.some((s) => url.toLowerCase().startsWith(s))) {
    return `K-Browser only opens http(s), about:blank and data: URLs, not ${JSON.stringify(String(url).slice(0, 80))}`;
  }
  return null;
}

/** @typedef {((params: Record<string, any>) => string | null) | null} Check */

/** @type {Check} */
const navigate = (p) => checkUrl(p.url);
/** @type {Check} */
// Chrome activates AND focuses the window for it (WebContents::Activate/Focus); K-Browser never takes the keyboard
// from the user, so it is refused rather than silently narrowed to "switch tab".
const bringToFront = () => 'Page.bringToFront is refused: K-Browser never brings its window to the front (it would take the user\'s keyboard)';
/** @type {Check} */
const autoAttach = (p) => (p.flatten === true ? null : 'Target.setAutoAttach is supported only with flatten: true');

/** @type {Map<string, Check>} */
export const ALLOWED = new Map(Object.entries({
  // --- used by Kav (kfw/*.py) ---
  'Page.enable': null,
  'Page.navigate': navigate,
  'Page.getFrameTree': null,
  'Page.captureScreenshot': null,
  'Page.bringToFront': bringToFront,
  'Page.addScriptToEvaluateOnNewDocument': null,
  'Page.removeScriptToEvaluateOnNewDocument': null,
  'Page.setPrerenderingAllowed': null,
  'Runtime.enable': null,
  'Runtime.evaluate': null,
  'Runtime.addBinding': null,
  'Runtime.removeBinding': null,
  'Input.dispatchMouseEvent': null,
  'Input.dispatchKeyEvent': null,
  'Input.insertText': null,
  'Emulation.setDeviceMetricsOverride': null,
  'Emulation.setFocusEmulationEnabled': null,
  'Network.enable': null,
  // --- needed by the SDK: isolated-world JS, AX snapshot, waiting, dialogs, child frames ---
  'Page.disable': null,
  'Page.reload': null,
  'Page.stopLoading': null,
  'Page.createIsolatedWorld': null,
  'Page.setLifecycleEventsEnabled': null,
  'Page.handleJavaScriptDialog': null,
  'Page.getLayoutMetrics': null,
  'Runtime.disable': null,
  'Runtime.callFunctionOn': null,
  'Runtime.getProperties': null,
  'Runtime.releaseObject': null,
  'Runtime.releaseObjectGroup': null,
  'DOM.enable': null,
  'DOM.disable': null,
  'DOM.getDocument': null,
  'DOM.describeNode': null,
  'DOM.resolveNode': null,
  'DOM.requestNode': null,
  'DOM.getBoxModel': null,
  'DOM.getContentQuads': null,
  'DOM.getNodeForLocation': null, // read-only hit test: the SDK checks what a click would land on
  'DOM.getFrameOwner': null, // read-only: the iframe element of a child frame, to map OOPIF coordinates
  'DOM.scrollIntoViewIfNeeded': null,
  'DOM.focus': null,
  'Accessibility.enable': null,
  'Accessibility.disable': null,
  'Accessibility.getFullAXTree': null,
  'Accessibility.getPartialAXTree': null,
  'DOMSnapshot.captureSnapshot': null,
  'Emulation.clearDeviceMetricsOverride': null,
  'Network.disable': null,
  'Network.getResponseBody': null,
  'Network.getRequestPostData': null,
  'Target.setAutoAttach': autoAttach,
}));

// Not allowed, recorded so a reviewer does not add them back by accident:
//   Network.getCookies/getAllCookies/setCookie(s)/deleteCookies/clearBrowserCookies/clearBrowserCache  cross-site profile state
//   Storage.*, IndexedDB.*, CacheStorage.*, DOMStorage.*  profile storage
//   DOM.setFileInputFiles  reads local files;  Page.setDownloadBehavior / Browser.setDownloadBehavior  writes to disk
//   IO.read  accepts blob:<uuid> handles looked up in the browser context, not owned by the tab
//   Fetch.*  rewrites responses;  Security.setIgnoreCertificateErrors
//   Network.setUserAgentOverride, Emulation.setTimezoneOverride/setLocaleOverride/setAutomationOverride  forge the
//   fingerprint

/** null when allowed, else the reason sent back to the client.
 * @param {unknown} method @param {Record<string, any>} [params] @returns {string | null} */
export function check(method, params = {}) {
  if (typeof method !== 'string' || !ALLOWED.has(method)) {
    return `'${String(method)}' is not allowed by K-Browser (exact allowlist in src/policy.js; default deny)`;
  }
  const validate = ALLOWED.get(method);
  return validate ? validate(params) : null;
}
