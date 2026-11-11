import { FakeNotion, crmPageProperties, crmSchema } from "./fake-notion";
import { SYNTHETIC_CONTACTS } from "./synthetic-contacts";

/** Fixed ids so local walkthroughs and docs can refer to them. */
export const MOCK_DATABASE_ID = "11111111-2222-4333-8444-555555555555";
export const MOCK_DATA_SOURCE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const MOCK_PARENT_PAGE_ID = "99999999-8888-4777-8666-555555555555";

export function seedSyntheticCrm(fake: FakeNotion) {
  fake.addDatabase({
    id: MOCK_DATABASE_ID,
    dataSourceId: MOCK_DATA_SOURCE_ID,
    title: "CRM (synthetic test data)",
    properties: crmSchema(),
    parentPageId: MOCK_PARENT_PAGE_ID,
  });
  fake.parentPages.add(MOCK_PARENT_PAGE_ID);
  const ids: Record<string, string> = {};
  for (const c of SYNTHETIC_CONTACTS) {
    ids[c.key] = fake.addPage(MOCK_DATA_SOURCE_ID, crmPageProperties(c), { inTrash: c.inTrash });
  }
  return { databaseId: MOCK_DATABASE_ID, dataSourceId: MOCK_DATA_SOURCE_ID, parentPageId: MOCK_PARENT_PAGE_ID, pageIds: ids };
}
