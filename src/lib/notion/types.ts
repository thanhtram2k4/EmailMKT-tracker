/**
 * Subset of the Notion API (version 2026-03-11, data-sources model) used by the CRM sync.
 * Shapes verified against developers.notion.com on 2026-11-12 (see docs/NOTION_SETUP.md).
 */
export const NOTION_API_VERSION = "2026-03-11";

export type RichTextItem = { type?: string; plain_text: string; text?: { content: string; link?: { url: string } | null } };

export type PropertyType = "title" | "rich_text" | "email" | "select" | "status" | "multi_select" | "date" | (string & {});

export type PropertySchema = {
  id: string;
  name: string;
  type: PropertyType;
  description?: string | null;
  select?: { options: Array<{ id?: string; name: string; color?: string }> };
  status?: { options: Array<{ id?: string; name: string; color?: string }> };
  multi_select?: { options: Array<{ id?: string; name: string; color?: string }> };
  [k: string]: unknown;
};

export type DataSource = {
  object: "data_source";
  id: string;
  title?: RichTextItem[];
  parent?: { type: "database_id"; database_id: string };
  in_trash?: boolean;
  properties: Record<string, PropertySchema>;
};

export type Database = {
  object: "database";
  id: string;
  title?: RichTextItem[];
  in_trash?: boolean;
  url?: string;
  data_sources: Array<{ id: string; name: string }>;
};

export type PropertyValue =
  | { id?: string; type: "title"; title: RichTextItem[] }
  | { id?: string; type: "rich_text"; rich_text: RichTextItem[] }
  | { id?: string; type: "email"; email: string | null }
  | { id?: string; type: "select"; select: { id?: string; name: string } | null }
  | { id?: string; type: "status"; status: { id?: string; name: string } | null }
  | { id?: string; type: "multi_select"; multi_select: Array<{ id?: string; name: string }> }
  | { id?: string; type: "date"; date: { start: string; end?: string | null; time_zone?: string | null } | null }
  | { id?: string; type: string; [k: string]: unknown };

export type Page = {
  object: "page";
  id: string;
  created_time: string;
  last_edited_time: string;
  in_trash?: boolean;
  is_archived?: boolean;
  url?: string;
  parent?: { type: string; data_source_id?: string; database_id?: string };
  properties: Record<string, PropertyValue>;
};

export type QueryResponse = {
  object: "list";
  results: Page[];
  next_cursor: string | null;
  has_more: boolean;
  /** Present when a query hit the 10,000-result cap: `type: "incomplete"`. */
  request_status?: { type: string; [k: string]: unknown };
};

export type NotionErrorBody = {
  object: "error";
  status: number;
  code: string;
  message: string;
  request_id?: string;
  additional_data?: Record<string, unknown>;
};
