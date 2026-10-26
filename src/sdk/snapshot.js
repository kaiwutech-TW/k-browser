// @ts-check
// Accessibility snapshot of a whole tab: one Accessibility.getFullAXTree per frame, merged along the frame tree.
//
// getFullAXTree covers one frame document only: the root call shows an iframe as an empty "Iframe" node, for
// same-process iframes as well as OOPIFs (measured). So every frame is fetched on the session
// that owns it, and placed under its owner element (found with DOM.describeNode, which reports the content frame of a
// frame owner element). A frame whose owner cannot be found is listed after its parent frame's nodes.
//
// A ref names one DOM node in one frame document: it is issued only for nodes that carry backendDOMNodeId (an
// optional field: CSS-generated text and inline text boxes lack it) and is valid only while the frame's stamp holds.

/** @typedef {import('./frames.js').Stamp} Stamp */
/** @typedef {{ ref: string, stamp: Stamp, backendNodeId: number, role: string, name: string }} RefEntry */

/** Roles that can be acted on: these get refs by default. */
export const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem',
  'MenuListPopup', 'MenuListOption', 'ListBoxOption', 'DisclosureTriangle', 'textField']);
/** A named image that is not inside a link or button may be clickable by itself (a date picker's calendar icon, deferred
 * #31): it gets a ref by default too. Images inside links and buttons (product grids) stay out: the link is the target. */
const IMAGE_ROLES = new Set(['image', 'img']);
const OUTER_TARGETS = new Set(['link', 'button', 'menuitem', 'tab', 'option', 'treeitem']);
/** Shown by default for orientation, without a ref. */
const STRUCTURE = new Set(['heading', 'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'form', 'search',
  'region', 'dialog', 'alertdialog', 'alert', 'Iframe']);
/** Never shown: noise. */
const HIDDEN = new Set(['InlineTextBox']);
const PROPS = ['checked', 'selected', 'expanded', 'pressed', 'disabled', 'required', 'invalid', 'focused', 'level'];
const NAME_MAX = 100;
// Defaults from measuring real sites: PChome 24h's home page has ~9,400 AX nodes (3.3 MB raw,
// ~180 ms); its default snapshot is ~750 lines / 52 KB, cut by these to 381 lines / 24 KB (the byte limit binds
// first). THSR and the Bank of Taiwan rate page fit whole. Whichever limit is hit first applies.
export const DEFAULT_MAX_LINES = 400;
export const DEFAULT_MAX_BYTES = 24 * 1024;

/** @param {any} n */
const role = (n) => String(n.role?.value ?? '');
/** @param {any} n */
const name = (n) => String(n.name?.value ?? '');

/** @param {string} s */
function clip(s) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > NAME_MAX ? `${one.slice(0, NAME_MAX)}…` : one;
}

/**
 * `hide`: frames not to read at all (a site policy, src/mcp/sites.js): each shows as one line, nothing of its content.
 * @param {{ client: import('./cdp.js').CdpClient, tree: import('./frames.js').FrameTree }} tab
 * @param {{ seq: number, full?: boolean, maxLines?: number, maxBytes?: number, hide?: Set<string> }} o
 */
export async function takeSnapshot({ client, tree }, { seq, full = false, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES, hide = new Set() }) {
  const started = Date.now();
  /** @type {string[]} */ const notes = [];
  const frames = tree.order().filter((f) => !hide.has(f.id)).map((f) => tree.stamp(f.id)).filter((s) => s !== null);
  // Fetch every frame (in parallel: different sessions, different renderers).
  const fetched = await Promise.all(frames.map(async (stamp) => {
    try {
      const r = await client.call('Accessibility.getFullAXTree', { frameId: stamp.frameId }, stamp.sessionId);
      // A reply that arrives after the frame changed describes the old document: discard it.
      if (!tree.same(stamp)) return { stamp, nodes: null, why: 'changed while it was read' };
      return { stamp, nodes: /** @type {any[]} */ (r.nodes ?? []), why: '' };
    } catch (e) {
      return { stamp, nodes: null, why: e instanceof Error ? e.message : 'error' };
    }
  }));
  /** @type {Map<string, { stamp: Stamp, byId: Map<string, any>, root: any }>} */
  const docs = new Map();
  let axNodes = 0;
  for (const f of fetched) {
    if (!f.nodes) {
      notes.push(`frame ${f.stamp.frameId} skipped: ${f.why}`);
      continue;
    }
    axNodes += f.nodes.length;
    const byId = new Map(f.nodes.map((n) => [n.nodeId, n]));
    const root = f.nodes.find((n) => !n.parentId || !byId.has(n.parentId)) ?? f.nodes[0];
    if (root) docs.set(f.stamp.frameId, { stamp: f.stamp, byId, root });
  }

  // Which element owns each child frame: frameId -> AX nodeId of the owner, in the parent's document.
  /** @type {Map<string, string>} */
  const ownerNode = new Map();
  for (const [frameId, doc] of docs) {
    const owners = [...doc.byId.values()].filter((n) => role(n) === 'Iframe' && Number.isInteger(n.backendDOMNodeId));
    await Promise.all(owners.map(async (n) => {
      try {
        const r = await client.call('DOM.describeNode', { backendNodeId: n.backendDOMNodeId }, doc.stamp.sessionId);
        const child = r.node?.frameId;
        if (typeof child === 'string' && child !== frameId && (docs.has(child) || hide.has(child))) ownerNode.set(child, n.nodeId);
      } catch { /* listed after its parent instead */ }
    }));
  }
  /** @type {Map<string, string[]>} AX nodeId (scoped by frame) -> child frames placed under it */
  const placed = new Map();
  /** @type {Map<string, string[]>} parent frameId -> child frames with no owner node found */
  const orphans = new Map();
  for (const frameId of [...docs.keys(), ...[...hide].filter((h) => tree.frames.has(h))]) {
    if (frameId === tree.mainFrameId) continue;
    const parent = tree.frames.get(frameId)?.parentId ?? null;
    const owner = ownerNode.get(frameId);
    if (owner && parent) {
      const key = `${parent}|${owner}`;
      placed.set(key, [...(placed.get(key) ?? []), frameId]);
    } else {
      const p = parent && docs.has(parent) ? parent : String(tree.mainFrameId);
      orphans.set(p, [...(orphans.get(p) ?? []), frameId]);
    }
  }

  /** @type {string[]} */ const lines = [];
  /** @type {RefEntry[]} */ const refs = [];
  let kept = 0;
  let bytes = 0;
  let truncated = false;
  /** Adds a line if it still fits (once one does not, nothing more is added). @param {string} text */
  const emit = (text) => {
    kept += 1;
    const b = Buffer.byteLength(text, 'utf8') + 1;
    if (!truncated && lines.length < maxLines && bytes + b <= maxBytes) {
      lines.push(text);
      bytes += b;
      return true;
    }
    truncated = true;
    return false;
  };
  /** @type {Set<string>} */
  const rendered = new Set();

  /** @param {string} frameId @param {number} depth @param {boolean} header */
  const renderFrame = (frameId, depth, header) => {
    if (hide.has(frameId)) {
      if (!rendered.has(frameId) && frameId !== tree.mainFrameId && !hide.has(tree.frames.get(frameId)?.parentId ?? '')) {
        emit(`${'  '.repeat(depth)}- frame hidden by site policy`);
      }
      rendered.add(frameId);
      return;
    }
    const doc = docs.get(frameId);
    if (!doc || rendered.has(frameId)) return;
    rendered.add(frameId);
    if (header) emit(`${'  '.repeat(depth)}- frame ${JSON.stringify(clip(tree.frames.get(frameId)?.url ?? ''))}`);
    const d0 = header ? depth + 1 : depth;
    /** @param {any} n @param {number} d @param {boolean} inTarget inside a link or button */
    const walk = (n, d, inTarget) => {
      const r = role(n);
      let next = d;
      const actable = INTERACTIVE.has(r) || (IMAGE_ROLES.has(r) && !inTarget && name(n) !== '');
      if (!n.ignored && !HIDDEN.has(r) && r !== 'RootWebArea') {
        const show = full ? !(r === 'StaticText' && !name(n)) && (r !== 'generic' || name(n)) : actable || STRUCTURE.has(r);
        if (show && r !== 'Iframe') {
          let line = `${'  '.repeat(d)}- ${r}`;
          if (name(n)) line += ` ${JSON.stringify(clip(name(n)))}`;
          const value = n.value?.value;
          if (value !== undefined && value !== '' && r !== 'StaticText') line += ` value=${JSON.stringify(clip(String(value)))}`;
          for (const p of n.properties ?? []) {
            if (!PROPS.includes(p.name)) continue;
            const v = p.value?.value;
            if (v === false || v === 'false' || v === undefined) continue;
            line += v === true || v === 'true' ? ` ${p.name}` : ` ${p.name}=${v}`;
          }
          // Refs only for lines actually shown: a ref nobody saw is an unexplained handle.
          const ref = Number.isInteger(n.backendDOMNodeId) && (full || actable) ? `s${seq}.${refs.length + 1}` : null;
          if (emit(ref ? `${line} [${ref}]` : line) && ref) {
            refs.push({ ref, stamp: doc.stamp, backendNodeId: n.backendDOMNodeId, role: r, name: name(n) });
          }
          next = d + 1;
        }
      }
      if (r === 'Iframe') {
        for (const child of placed.get(`${frameId}|${n.nodeId}`) ?? []) renderFrame(child, d, true);
      }
      for (const id of n.childIds ?? []) {
        const c = doc.byId.get(id);
        if (c) walk(c, next, inTarget || (!n.ignored && OUTER_TARGETS.has(r)));
      }
    };
    walk(doc.root, d0, false);
    for (const child of orphans.get(frameId) ?? []) renderFrame(child, d0, true);
  };
  if (tree.mainFrameId) renderFrame(tree.mainFrameId, 0, false);
  for (const frameId of docs.keys()) renderFrame(frameId, 0, true); // anything not reached from the main frame

  if (truncated) notes.push(`truncated: showing ${lines.length} of ${kept} lines (limits: ${maxLines} lines, ${maxBytes} bytes)`);
  return {
    text: lines.join('\n'),
    refs,
    stats: { frames: docs.size, axNodes, lines: kept, shown: lines.length, refs: refs.length, ms: Date.now() - started },
    truncated,
    notes,
  };
}
