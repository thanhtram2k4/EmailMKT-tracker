/**
 * Field mapping between app contact fields and Notion data-source properties, plus parsing of
 * Notion page values and building of app→Notion writes.
 *
 * Ownership (DESIGN §3.3):
 *   Notion-owned (read only by the app): fullName, greetingName, email, company, tags, consentEvidence
 *   App-owned (written by the app, read only for the human-unsubscribe signal): subscriptionStatus
 *   App-owned (written by the app from M5/M7): lastEmailed, lastEngagement
 */
import type { DataSource, Page, PropertySchema, PropertyType, PropertyValue, RichTextItem } from "../notion/types";
import type { ContactFields } from "./contact-validation";
import type { suppressionReason } from "../db/schema";

export const APP_FIELDS = {
  fullName: { label: "Full name", required: true, types: ["title"], owner: "notion" },
  email: { label: "Email", required: true, types: ["email", "rich_text"], owner: "notion" },
  greetingName: { label: "Greeting name", required: false, types: ["rich_text"], owner: "notion" },
  company: { label: "Company", required: false, types: ["rich_text", "select"], owner: "notion" },
  tags: { label: "Tags", required: false, types: ["multi_select"], owner: "notion" },
  consentEvidence: { label: "Consent evidence (reference only)", required: false, types: ["rich_text", "url"], owner: "notion" },
  subscriptionStatus: { label: "Subscription status", required: false, types: ["select", "status"], owner: "app" },
  lastEmailed: { label: "Last emailed", required: false, types: ["date"], owner: "app" },
  lastEngagement: { label: "Last engagement", required: false, types: ["date"], owner: "app" },
} as const satisfies Record<string, { label: string; required: boolean; types: readonly PropertyType[]; owner: "notion" | "app" }>;

export type AppField = keyof typeof APP_FIELDS;
export type FieldMapping = Partial<Record<AppField, string>>;

/** Notion "Subscription status" option names written by the app. */
export const SUBSCRIPTION_LABELS = {
  subscribed: "Subscribed",
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  complained: "Complained",
} as const;

/**
 * Notion values that a person may set to stop email. Treated as a suppression request.
 * "Subscribed" (or blank) is NEVER treated as consent and never removes a suppression.
 */
export function isSuppressingNotionValue(v: string | null | undefined): boolean {
  if (!v) return false;
  const n = v.trim().toLowerCase();
  return n === "unsubscribed" || n === "bounced" || n === "complained";
}

export function labelForSuppression(reason: (typeof suppressionReason.enumValues)[number]): string {
  if (reason === "hard_bounce") return SUBSCRIPTION_LABELS.bounced;
  if (reason === "complaint") return SUBSCRIPTION_LABELS.complained;
  return SUBSCRIPTION_LABELS.unsubscribed;
}

// ------------------------------------------------------------------ validation

export type MappingValidation = { ok: boolean; errors: string[]; warnings: string[] };

export function validateMapping(mapping: FieldMapping, ds: Pick<DataSource, "properties">): MappingValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const used = new Map<string, AppField>();
  for (const [field, def] of Object.entries(APP_FIELDS) as Array<[AppField, (typeof APP_FIELDS)[AppField]]>) {
    const prop = mapping[field];
    if (!prop) {
      if (def.required) errors.push(`${def.label} must be mapped to a Notion property`);
      continue;
    }
    const schema = ds.properties[prop];
    if (!schema) {
      errors.push(`${def.label}: Notion property "${prop}" does not exist (renamed or deleted?)`);
      continue;
    }
    if (!(def.types as readonly string[]).includes(schema.type)) {
      errors.push(`${def.label}: property "${prop}" has type "${schema.type}", expected ${def.types.join(" or ")}`);
    }
    const prev = used.get(prop);
    if (prev) errors.push(`"${prop}" is mapped to both ${APP_FIELDS[prev].label} and ${def.label}`);
    used.set(prop, field);
  }
  const sub = mapping.subscriptionStatus ? ds.properties[mapping.subscriptionStatus] : undefined;
  if (!mapping.subscriptionStatus) {
    warnings.push("Subscription status is not mapped: unsubscribes made in Notion cannot be detected and suppressions are not mirrored to Notion");
  } else if (sub?.type === "status") {
    const names = new Set((sub.status?.options ?? []).map((o) => o.name));
    const missing = Object.values(SUBSCRIPTION_LABELS).filter((l) => !names.has(l));
    if (missing.length) warnings.push(`Status property "${sub.name}" lacks options ${missing.join(", ")}; the app cannot write those values (status options can only be added in Notion)`);
  }
  if (!mapping.greetingName) warnings.push("Greeting name is not mapped: greetings will always use the fallback text");
  return { ok: errors.length === 0, errors, warnings };
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const NAME_HINTS: Record<AppField, string[]> = {
  fullName: ["full name", "name", "ho ten", "ho va ten", "ten"],
  email: ["email", "e mail", "mail", "thu dien tu"],
  greetingName: ["greeting name", "greeting", "ten goi", "xung ho", "salutation", "nickname"],
  company: ["company", "cong ty", "organization", "organisation", "doanh nghiep"],
  tags: ["tags", "tag", "nhan", "labels", "segments"],
  consentEvidence: ["consent evidence", "consent", "bang chung dong y", "dong y"],
  subscriptionStatus: ["subscription status", "subscription", "email status", "trang thai dang ky"],
  lastEmailed: ["last emailed", "last email", "lan gui cuoi"],
  lastEngagement: ["last engagement", "last activity", "tuong tac cuoi"],
};

/** Suggest a mapping from property names/types. The admin reviews it before saving. */
export function suggestMapping(ds: Pick<DataSource, "properties">): FieldMapping {
  const props = Object.values(ds.properties);
  const out: FieldMapping = {};
  const taken = new Set<string>();
  for (const field of Object.keys(APP_FIELDS) as AppField[]) {
    const def = APP_FIELDS[field];
    const candidates = props.filter((p) => (def.types as readonly string[]).includes(p.type) && !taken.has(p.name));
    let pick: PropertySchema | undefined;
    for (const hint of NAME_HINTS[field]) {
      pick = candidates.find((p) => fold(p.name) === hint);
      if (pick) break;
    }
    if (!pick && field === "fullName") pick = candidates.find((p) => p.type === "title");
    if (!pick && field === "email") pick = candidates.find((p) => p.type === "email");
    if (pick) {
      out[field] = pick.name;
      taken.add(pick.name);
    }
  }
  return out;
}

// ------------------------------------------------------------------ CRM database schema

/** Properties for "Create CRM database" (Notion `initial_data_source.properties`). */
export const CRM_DATABASE_PROPERTIES: Record<string, unknown> = {
  Name: { title: {} },
  "Greeting name": { rich_text: {} },
  Email: { email: {} },
  Company: { rich_text: {} },
  Tags: { multi_select: {} },
  "Consent evidence": { rich_text: {} },
  "Subscription status": {
    select: {
      options: [
        { name: SUBSCRIPTION_LABELS.subscribed, color: "green" },
        { name: SUBSCRIPTION_LABELS.unsubscribed, color: "gray" },
        { name: SUBSCRIPTION_LABELS.bounced, color: "orange" },
        { name: SUBSCRIPTION_LABELS.complained, color: "red" },
      ],
    },
  },
  "Last emailed": { date: {} },
  "Last engagement": { date: {} },
};

export const CRM_DATABASE_MAPPING: FieldMapping = {
  fullName: "Name",
  greetingName: "Greeting name",
  email: "Email",
  company: "Company",
  tags: "Tags",
  consentEvidence: "Consent evidence",
  subscriptionStatus: "Subscription status",
  lastEmailed: "Last emailed",
  lastEngagement: "Last engagement",
};

// ------------------------------------------------------------------ page parsing

export type PageProblem = { code: string; message: string };

export type ParsedPage = {
  fields: ContactFields;
  subscriptionValue: string | null;
  consentEvidence: string | null;
  problems: PageProblem[];
};

const plain = (items: RichTextItem[] | undefined) => (items ?? []).map((i) => i.plain_text ?? i.text?.content ?? "").join("");

function readText(v: PropertyValue | undefined): string | null {
  if (!v) return null;
  switch (v.type) {
    case "title":
      return plain((v as { title: RichTextItem[] }).title) || null;
    case "rich_text":
      return plain((v as { rich_text: RichTextItem[] }).rich_text) || null;
    case "email":
      return (v as { email: string | null }).email ?? null;
    case "select":
      return (v as { select: { name: string } | null }).select?.name ?? null;
    case "status":
      return (v as { status: { name: string } | null }).status?.name ?? null;
    case "url":
      return ((v as { url?: string | null }).url as string | null) ?? null;
    default:
      return null;
  }
}

export function parsePage(page: Page, mapping: FieldMapping): ParsedPage {
  const problems: PageProblem[] = [];
  const get = (field: AppField): PropertyValue | undefined => {
    const name = mapping[field];
    if (!name) return undefined;
    const v = page.properties?.[name];
    if (!v) {
      problems.push({ code: "property_missing_on_page", message: `Page has no property "${name}" (${APP_FIELDS[field].label})` });
      return undefined;
    }
    if (!(APP_FIELDS[field].types as readonly string[]).includes(v.type)) {
      problems.push({
        code: "unexpected_property_type",
        message: `Property "${name}" has type "${v.type}" on this page, expected ${APP_FIELDS[field].types.join("/")}`,
      });
      return undefined;
    }
    return v;
  };
  const tagsV = get("tags");
  const tags = tagsV && tagsV.type === "multi_select" ? (tagsV as { multi_select: Array<{ name: string }> }).multi_select.map((t) => t.name) : [];
  return {
    fields: {
      fullName: readText(get("fullName")),
      greetingName: readText(get("greetingName")),
      email: readText(get("email")),
      company: readText(get("company")),
      tags,
    },
    subscriptionValue: readText(get("subscriptionStatus")),
    consentEvidence: readText(get("consentEvidence")),
    problems,
  };
}

/** Build the PATCH properties body to set the subscription status to `label`. */
export function subscriptionWrite(mapping: FieldMapping, propertyType: "select" | "status", label: string): Record<string, unknown> {
  const name = mapping.subscriptionStatus;
  if (!name) throw new Error("subscriptionStatus is not mapped");
  return { [name]: propertyType === "status" ? { status: { name: label } } : { select: { name: label } } };
}
