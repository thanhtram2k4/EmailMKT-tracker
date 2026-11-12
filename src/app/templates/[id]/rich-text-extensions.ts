/**
 * TipTap configuration shared by the formatting-toolbar field and the conversion preview, so the
 * editor can show EXACTLY which formatting a conversion would remove before the user confirms.
 */
import { generateHTML, generateJSON } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { toInlineHtml } from "../../../lib/templates/inline";

export const richTextExtensions = [
  StarterKit.configure({
    heading: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    blockquote: false,
    codeBlock: false,
    horizontalRule: false,
    // Do not add target/rel to links (they would count as changed formatting).
    link: { openOnClick: false, autolink: false, HTMLAttributes: { target: null, rel: null } },
  }),
];

/** What the toolbar editor would produce from this inline HTML without any typing. */
export function richTextRoundTrip(inlineHtml: string): string {
  return toInlineHtml(generateHTML(generateJSON(inlineHtml, richTextExtensions), richTextExtensions));
}
