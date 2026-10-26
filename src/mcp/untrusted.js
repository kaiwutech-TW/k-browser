// @ts-check
// Page content is untrusted: everything a page supplies — read and snapshot text,
// tab titles, URLs, dialog messages, error messages a page caused, network records and bodies — goes to the agent
// inside one <untrusted-page-content> block, and the tool descriptions say instructions in there are not the user's.
//
// Escaping a fake closing tag only keeps the block's structure intact: a page can still write text that persuades a
// model. It is not a complete defence against prompt injection.

export const TAG = 'untrusted-page-content';
const FAKE_TAG = /<(\s*\/?\s*)(untrusted-page-content)/gi;

/** The text with any opening or closing tag of the block defused (`<` becomes `&lt;`). @param {string} s */
export const escapeTags = (s) => String(s).replace(FAKE_TAG, '&lt;$1$2');

/** @param {string} s */
export const wrap = (s) => `<${TAG}>\n${escapeTags(s)}\n</${TAG}>`;
