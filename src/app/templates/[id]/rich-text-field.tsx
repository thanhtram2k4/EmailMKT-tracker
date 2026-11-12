"use client";
/**
 * Formatting-toolbar field (TipTap) for one text block: bold, italic, links and pasted formatted
 * text. It is an explicit, opt-in conversion: TipTap cannot represent every inline style, so the
 * editor shows what the conversion removes and offers undo before this field is used.
 */
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect } from "react";
import { toInlineHtml } from "../../../lib/templates/inline";
import { richTextExtensions } from "./rich-text-extensions";

export function RichTextField(props: { initialHtml: string; onChange: (inlineHtml: string) => void; insertText?: string | null; onInserted?: () => void }) {
  const editor = useEditor({
    extensions: richTextExtensions,
    content: props.initialHtml,
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => props.onChange(toInlineHtml(e.getHTML())),
  });

  useEffect(() => {
    if (editor && props.insertText) {
      editor.chain().focus().insertContent(props.insertText).run();
      props.onInserted?.();
    }
  }, [editor, props]);

  if (!editor) return <div className="muted small">Loading editor…</div>;
  return (
    <div className="rte">
      <div className="row rte-toolbar">
        <button type="button" className="btn small-btn" onClick={() => editor.chain().focus().toggleBold().run()} aria-pressed={editor.isActive("bold")}>
          <strong>B</strong>
        </button>
        <button type="button" className="btn small-btn" onClick={() => editor.chain().focus().toggleItalic().run()} aria-pressed={editor.isActive("italic")}>
          <em>I</em>
        </button>
        <button
          type="button"
          className="btn small-btn"
          onClick={() => {
            const href = window.prompt("Link URL (https://…, mailto:, tel:)", editor.getAttributes("link").href ?? "https://");
            if (href === null) return;
            if (href === "") editor.chain().focus().unsetLink().run();
            else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
          }}
        >
          Link
        </button>
      </div>
      <EditorContent editor={editor} data-testid="edit-text" />
    </div>
  );
}
