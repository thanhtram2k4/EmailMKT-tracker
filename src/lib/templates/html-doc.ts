/**
 * Structure-preserving HTML parse/serialize for email templates.
 *
 * Uses cheerio in htmlparser2 mode (NOT the HTML5 tree builder): source structure is kept as
 * written — no implied <tbody>, comments (incl. MSO conditional comments) and entities are kept
 * verbatim. Measured differences on round-trip are only cosmetic: `<br />` → `<br>` and
 * single-quoted attributes → double-quoted, valueless attributes → `attr=""` (see tests/unit/templates.test.ts).
 */
import * as cheerio from "cheerio";

export type Doc = cheerio.CheerioAPI;

export function parseHtml(html: string): Doc {
  // emptyAttrs keeps alt="" (common in email); valueless attributes such as `nowrap` become `nowrap=""`.
  return cheerio.load(html, { xml: { xmlMode: false, decodeEntities: false, emptyAttrs: true } });
}

export function serialize($: Doc): string {
  return $.html();
}

/** Normalize the two cosmetic serializer differences so round-trips can be compared exactly. */
export function normalizeForCompare(html: string): string {
  return parseHtml(html).html();
}

export function countConditionalComments(html: string): number {
  return (html.match(/<!--\[if[^\]]*\]>/gi) ?? []).length + (html.match(/<!--<!\[endif\]-->/gi) ?? []).length;
}
