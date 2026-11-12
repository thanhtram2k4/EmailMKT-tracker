"use client";
/**
 * TipTap field for editing one text block of a template (candidate (c) in the plan: formatted-
 * text paste). Output is converted to INLINE HTML (no <p> wrappers) because the block lives inside
 * an existing table cell / paragraph of the template. Supported marks: bold, italic, underline,
 * strike, code, links, line breaks. Other inline formatting (colours, font sizes, <font>) is not
 * representable and is dropped when the block is edited — the editor warns before that happens.
 */
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { toInlineHtml } from "../../../lib/templates/inline";

export function RichTextField(props: { initialHtml: string; onChange: (inlineHtml: string) => void; insertText?: string | null; onInserted?: () => void }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: false },
      }),
    ],
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
