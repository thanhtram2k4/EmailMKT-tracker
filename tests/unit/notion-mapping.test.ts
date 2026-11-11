import { describe, expect, it } from "vitest";
import { parseNotionId } from "../../src/lib/crm/connection";
import { CRM_DATABASE_MAPPING, isSuppressingNotionValue, parsePage, subscriptionWrite, suggestMapping, validateMapping } from "../../src/lib/crm/mapping";
import type { Page, PropertySchema } from "../../src/lib/notion/types";
import { crmPageProperties, crmSchema } from "../../scripts/notion-mock/fake-notion";

const page = (props: Page["properties"]): Page => ({ object: "page", id: "p1", created_time: "", last_edited_time: "2026-11-12T00:00:00.000Z", properties: props });

describe("mapping validation", () => {
  it("accepts the standard CRM schema", () => {
    expect(validateMapping(CRM_DATABASE_MAPPING, { properties: crmSchema() })).toMatchObject({ ok: true, errors: [] });
  });
  it("requires full name and email", () => {
    const v = validateMapping({}, { properties: crmSchema() });
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/Full name.*Email|Email.*Full name/s);
  });
  it("detects renamed/deleted properties and wrong types", () => {
    const schema = crmSchema();
    delete (schema as Record<string, PropertySchema>)["Greeting name"];
    const v1 = validateMapping(CRM_DATABASE_MAPPING, { properties: schema });
    expect(v1.errors.join()).toMatch(/"Greeting name" does not exist/);
    const v2 = validateMapping({ ...CRM_DATABASE_MAPPING, email: "Company" }, { properties: crmSchema() });
    expect(v2.errors.join()).toMatch(/Company/);
  });
  it("rejects one property mapped to two fields", () => {
    expect(validateMapping({ ...CRM_DATABASE_MAPPING, company: "Greeting name" }, { properties: crmSchema() }).errors.join()).toMatch(/mapped to both/);
  });
  it("warns when a status-type subscription property lacks the app's options", () => {
    const schema = crmSchema();
    schema["Subscription status"] = { id: "s", name: "Subscription status", type: "status", status: { options: [{ name: "Subscribed" }] } };
    expect(validateMapping(CRM_DATABASE_MAPPING, { properties: schema }).warnings.join()).toMatch(/lacks options/);
  });
});

describe("mapping suggestion", () => {
  it("recognizes English and Vietnamese property names", () => {
    const vi: Record<string, PropertySchema> = {
      "Họ và tên": { id: "title", name: "Họ và tên", type: "title" },
      "Thư điện tử": { id: "e", name: "Thư điện tử", type: "email" },
      "Tên gọi": { id: "g", name: "Tên gọi", type: "rich_text" },
      "Công ty": { id: "c", name: "Công ty", type: "select", select: { options: [] } },
      Nhãn: { id: "t", name: "Nhãn", type: "multi_select", multi_select: { options: [] } },
    };
    expect(suggestMapping({ properties: vi })).toEqual({ fullName: "Họ và tên", email: "Thư điện tử", greetingName: "Tên gọi", company: "Công ty", tags: "Nhãn" });
    expect(suggestMapping({ properties: crmSchema() })).toEqual(CRM_DATABASE_MAPPING);
  });
});

describe("page parsing", () => {
  it("reads every mapped field from Notion value shapes", () => {
    const p = parsePage(page(crmPageProperties({ name: "Nguyễn Văn An", greeting: "Anh An", email: "an@example.com", company: "An Phát", tags: ["VIP"], subscription: "Subscribed", consentEvidence: "F-1" })), CRM_DATABASE_MAPPING);
    expect(p).toEqual({
      fields: { fullName: "Nguyễn Văn An", greetingName: "Anh An", email: "an@example.com", company: "An Phát", tags: ["VIP"] },
      subscriptionValue: "Subscribed",
      consentEvidence: "F-1",
      problems: [],
    });
  });
  it("reports a missing property or an unexpected type instead of crashing", () => {
    const props = crmPageProperties({ name: "X", email: "x@example.com" });
    delete (props as Record<string, unknown>)["Greeting name"];
    (props as Record<string, unknown>).Email = { type: "number", number: 5 };
    const p = parsePage(page(props), CRM_DATABASE_MAPPING);
    expect(p.problems.map((x) => x.code)).toEqual(["property_missing_on_page", "unexpected_property_type"]);
    expect(p.fields.email).toBeNull();
  });
  it("builds select and status writes", () => {
    expect(subscriptionWrite(CRM_DATABASE_MAPPING, "select", "Unsubscribed")).toEqual({ "Subscription status": { select: { name: "Unsubscribed" } } });
    expect(subscriptionWrite(CRM_DATABASE_MAPPING, "status", "Unsubscribed")).toEqual({ "Subscription status": { status: { name: "Unsubscribed" } } });
  });
  it("only Unsubscribed/Bounced/Complained count as suppression requests", () => {
    expect(["Unsubscribed", "bounced", " Complained "].every(isSuppressingNotionValue)).toBe(true);
    expect([null, "", "Subscribed", "Đã hủy"].some(isSuppressingNotionValue)).toBe(false);
  });
});

describe("Notion id parsing", () => {
  it("accepts bare ids, dashed ids and URLs", () => {
    const id = "1f2e3d4c5b6a47988796a5b4c3d2e1f0";
    const dashed = "1f2e3d4c-5b6a-4798-8796-a5b4c3d2e1f0";
    expect(parseNotionId(id)).toBe(dashed);
    expect(parseNotionId(dashed.toUpperCase())).toBe(dashed);
    expect(parseNotionId(`https://www.notion.so/acme/CRM-${id}?v=abc`)).toBe(dashed);
    expect(parseNotionId("not an id")).toBeNull();
  });
});
