// @ts-check
import fs from 'node:fs';

/** @type {string} */
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
/** Pinned by the "key" in extension/manifest.json. */
export const EXTENSION_ID = 'olakpcnfpffffpakpoleompemlalacdb';
