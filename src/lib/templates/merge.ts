/**
 * Merge fields (Liquid output syntax only): {{ field }} or {{ field | filter: "arg" | … }}.
 *
 * Security: Liquid *tags* ({% … %}) are NOT executed — LiquidJS tags such as include/render could
 * read files from the server. They are reported and rendered literally. Only allowlisted fields
 * and filters are accepted; values are HTML-escaped on output.
 *
 * Robustness: editors may entity-encode quotes inside braces (e.g. &quot;Quý khách&quot;); those
 * entities are decoded inside {{ }} before parsing.
 */
import { Liquid } from "liquidjs";

export const MERGE_FIELDS = {
  full_name: "Full name",
  greeting_name: "Greeting name (e.g. Anh An, Chị Ngọc)",
  company: "Company",
  email: "Email address",
  unsubscribe_url: "Unsubscribe link (set at send time)",
} as const;
export type MergeField = keyof typeof MERGE_FIELDS;

export const ALLOWED_FILTERS = ["default", "upcase", "downcase", "capitalize", "url_encode", "strip"] as const;

const OUTPUT = /\{\{([\s\S]*?)\}\}/g;
const TAG = /\{%[\s\S]*?%\}/g;

const decodeInside = (s: string) =>
  s.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&");

export type MergeUse = {
  raw: string;
  field: string | null;
  filters: string[];
  hasFallback: boolean;
  context: "text" | "attribute";
  problem?: "unknown_field" | "unknown_filter" | "syntax" | "missing_fallback_in_href";
};

const EXPR = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*((?:\|\s*[A-Za-z_]+\s*(?::\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+))?\s*)*)$/;

function parseExpr(inner: string): { field: string; filters: string[]; fallback: boolean } | null {
  const m = EXPR.exec(decodeInside(inner));
  if (!m) return null;
  const filters = [...m[2].matchAll(/\|\s*([A-Za-z_]+)/g)].map((x) => x[1]);
  return { field: m[1], filters, fallback: filters.includes("default") };
}

/** Find every merge field use and classify problems. Context is detected per occurrence. */
export function scanMergeFields(html: string): { uses: MergeUse[]; liquidTags: string[] } {
  const uses: MergeUse[] = [];
  for (const m of html.matchAll(OUTPUT)) {
    const before = html.slice(Math.max(0, m.index! - 400), m.index!);
    const lastOpen = before.lastIndexOf("<");
    const lastClose = before.lastIndexOf(">");
    const context: MergeUse["context"] = lastOpen > lastClose ? "attribute" : "text";
    const inHref = context === "attribute" && /href\s*=\s*["'][^"']*$/i.test(before);
    const p = parseExpr(m[1]);
    if (!p) {
      uses.push({ raw: m[0], field: null, filters: [], hasFallback: false, context, problem: "syntax" });
      continue;
    }
    let problem: MergeUse["problem"];
    if (!(p.field in MERGE_FIELDS)) problem = "unknown_field";
    else if (p.filters.some((f) => !(ALLOWED_FILTERS as readonly string[]).includes(f))) problem = "unknown_filter";
    else if (inHref && p.field !== "unsubscribe_url" && !p.fallback && p.field !== "email") problem = "missing_fallback_in_href";
    uses.push({ raw: m[0], field: p.field, filters: p.filters, hasFallback: p.fallback, context, problem });
  }
  return { uses, liquidTags: html.match(TAG) ?? [] };
}

export type Recipient = Partial<Record<MergeField, string | null>>;

const engine = new Liquid({
  relativeReference: false,
  strictFilters: true,
  strictVariables: false,
  outputEscape: "escape",
  ownPropertyOnly: true,
  // No file system: include/render/layout can never read files.
  fs: {
    exists: async () => false,
    existsSync: () => false,
    readFile: async () => {
      throw new Error("file access disabled");
    },
    readFileSync: () => {
      throw new Error("file access disabled");
    },
    resolve: () => "",
  },
  root: [],
});

export type RenderResult = {
  html: string;
  missingWithoutFallback: string[];
  errors: Array<{ raw: string; error: string }>;
};

/** Render merge fields for one recipient (preview). Liquid tags stay literal. */
export function renderForRecipient(html: string, r: Recipient): RenderResult {
  const missing = new Set<string>();
  const errors: RenderResult["errors"] = [];
  const ctx: Record<string, string> = {};
  for (const k of Object.keys(MERGE_FIELDS)) {
    const v = r[k as MergeField];
    if (v !== null && v !== undefined && String(v).trim() !== "") ctx[k] = String(v);
  }
  const out = html.replace(OUTPUT, (raw, inner: string) => {
    const p = parseExpr(inner);
    if (!p || !(p.field in MERGE_FIELDS) || p.filters.some((f) => !(ALLOWED_FILTERS as readonly string[]).includes(f))) {
      errors.push({ raw, error: !p ? "syntax" : !(p.field in MERGE_FIELDS) ? "unknown field" : "unknown filter" });
      return raw; // leave visible so the problem is obvious in the preview
    }
    if (!(p.field in ctx) && !p.fallback) missing.add(p.field);
    try {
      return engine.parseAndRenderSync(`{{${decodeInside(inner)}}}`, ctx);
    } catch (e) {
      errors.push({ raw, error: e instanceof Error ? e.message : String(e) });
      return raw;
    }
  });
  return { html: out, missingWithoutFallback: [...missing], errors };
}

/** Built-in SYNTHETIC preview recipients (always available, even with an empty CRM). */
export const SAMPLE_RECIPIENTS: Array<{ id: string; label: string; data: Recipient }> = [
  { id: "sample-full", label: "Mẫu: đủ thông tin (Anh An, Công ty An Phát)", data: { full_name: "Nguyễn Văn An", greeting_name: "Anh An", company: "Công ty An Phát", email: "an.nguyen@congty-anphat.example", unsubscribe_url: "https://app.example/u/preview" } },
  { id: "sample-no-greeting", label: "Mẫu: thiếu tên gọi", data: { full_name: "Lê Hoàng Phúc", greeting_name: null, company: "Phúc Lợi JSC", email: "phuc.le@example.org", unsubscribe_url: "https://app.example/u/preview" } },
  { id: "sample-no-company", label: "Mẫu: thiếu công ty và tên gọi", data: { full_name: "Võ Minh Thư", greeting_name: null, company: null, email: "thu.vo@example.net", unsubscribe_url: "https://app.example/u/preview" } },
];

// ---------------------------------------------------------------- M4: subject lines

/** Same rules as the body, but values are NOT HTML-escaped: the subject is a plain-text header. */
const textEngine = new Liquid({
  relativeReference: false,
  strictFilters: true,
  strictVariables: false,
  ownPropertyOnly: true,
  fs: {
    exists: async () => false,
    existsSync: () => false,
    readFile: async () => {
      throw new Error("file access disabled");
    },
    readFileSync: () => {
      throw new Error("file access disabled");
    },
    resolve: () => "",
  },
  root: [],
});

export const MAX_SUBJECT_LENGTH = 200;

export type SubjectProblem = { raw: string; error: string };

/** Static problems in a subject template (independent of any recipient). */
export function scanSubject(subject: string): SubjectProblem[] {
  const problems: SubjectProblem[] = [];
  if (/[\r\n]/.test(subject)) problems.push({ raw: "(line break)", error: "line breaks are not allowed in a subject" });
  if (subject.length > MAX_SUBJECT_LENGTH) problems.push({ raw: subject.slice(0, 30) + "…", error: `longer than ${MAX_SUBJECT_LENGTH} characters` });
  for (const t of subject.match(TAG) ?? []) problems.push({ raw: t, error: "Liquid tags are not allowed (only {{ field }} output)" });
  for (const u of scanMergeFields(subject).uses) {
    if (u.problem) problems.push({ raw: u.raw, error: u.problem.replace(/_/g, " ") });
    else if (u.field === "unsubscribe_url") problems.push({ raw: u.raw, error: "unsubscribe_url cannot be used in a subject" });
  }
  return problems;
}

export type SubjectRender = { subject: string; missingWithoutFallback: string[]; errors: SubjectProblem[] };

/**
 * Render a subject for one recipient. Liquid tags stay literal (never executed). The result is
 * refused (error) if it contains a line break — that would allow header injection.
 */
export function renderSubject(subject: string, r: Recipient): SubjectRender {
  const errors = scanSubject(subject);
  const missing = new Set<string>();
  const ctx: Record<string, string> = {};
  for (const k of Object.keys(MERGE_FIELDS)) {
    const v = r[k as MergeField];
    if (v !== null && v !== undefined && String(v).trim() !== "") ctx[k] = String(v);
  }
  const out = subject.replace(OUTPUT, (raw, inner: string) => {
    const p = parseExpr(inner);
    if (!p || !(p.field in MERGE_FIELDS) || p.filters.some((f) => !(ALLOWED_FILTERS as readonly string[]).includes(f))) return raw;
    if (!(p.field in ctx) && !p.fallback) missing.add(p.field);
    try {
      return textEngine.parseAndRenderSync(`{{${decodeInside(inner)}}}`, ctx);
    } catch (e) {
      errors.push({ raw, error: e instanceof Error ? e.message : String(e) });
      return raw;
    }
  });
  const rendered = out.replace(/\s+/g, " ").trim();
  if (/[\r\n]/.test(out.trim()) && !errors.some((e) => e.raw === "(line break)")) errors.push({ raw: "(value)", error: "a merge value contains a line break" });
  return { subject: rendered, missingWithoutFallback: [...missing], errors };
}

/** Fields used WITHOUT a `default:` fallback in a subject or body (each needs a value per recipient). */
export function fieldsNeedingValues(...templates: string[]): string[] {
  const need = new Set<string>();
  for (const t of templates) {
    for (const u of scanMergeFields(t).uses) {
      if (!u.problem && u.field && !u.hasFallback && u.field !== "unsubscribe_url") need.add(u.field);
    }
  }
  return [...need].sort();
}

/** Render merge fields in the plain-text part (no HTML escaping; line breaks kept). */
export function renderText(text: string, r: Recipient): { text: string; errors: SubjectProblem[] } {
  const errors: SubjectProblem[] = [];
  const ctx: Record<string, string> = {};
  for (const k of Object.keys(MERGE_FIELDS)) {
    const v = r[k as MergeField];
    if (v !== null && v !== undefined && String(v).trim() !== "") ctx[k] = String(v);
  }
  const out = text.replace(OUTPUT, (raw, inner: string) => {
    const p = parseExpr(inner);
    if (!p || !(p.field in MERGE_FIELDS) || p.filters.some((f) => !(ALLOWED_FILTERS as readonly string[]).includes(f))) {
      errors.push({ raw, error: "invalid merge field" });
      return raw;
    }
    try {
      return textEngine.parseAndRenderSync(`{{${decodeInside(inner)}}}`, ctx);
    } catch (e) {
      errors.push({ raw, error: e instanceof Error ? e.message : String(e) });
      return raw;
    }
  });
  return { text: out, errors };
}
