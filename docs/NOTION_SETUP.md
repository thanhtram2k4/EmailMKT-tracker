# Connecting a separate Notion TEST database

Use this guide when you are ready to replace the local mock with a real Notion test database.

**Authorization comes first.** Connecting any real Notion database, even a test one, needs your explicit approval, recorded in `NOTION_AUTHORIZATION_REF`. The M2 authorization covered mocks and synthetic data only.

**Never paste the Notion token into chat, tickets, email, Git or any `.env` file in the repository.** You enter it once, in the app's admin screen. The app encrypts it before storing it and never shows it again.

Source: the Notion API reference at developers.notion.com, checked 2026-11-12. The app pins API version **2026-03-11**, which uses the "data sources" model.

## 1. Prepare the test workspace content (Notion workspace owner)
1. Create a page that will only ever hold test data, for example **"Email MKT Tracker — TEST"**. A separate teamspace works too.
2. Keep test data and real customer data apart.
   - Put only designated test contacts on this page: addresses at test domains or test inboxes you control.
   - Do **not** copy real customers into it.
3. Choose **one** of the following:
   - **Let the app create the database** (recommended). Step 4 below creates "Email CRM contacts" under this page with the right schema.
   - **Map an existing test database.** It must have at least these properties:

| App field | Notion property type | Owner | Notes |
|---|---|---|---|
| Full name | `title` | Notion | required |
| Email | `email` (or `rich_text`) | Notion | required |
| Greeting name | `rich_text` | Notion | e.g. "Anh An", "Chị Ngọc"; blank means the fallback greeting is used |
| Company | `rich_text` or `select` | Notion | |
| Tags | `multi_select` | Notion | |
| Consent evidence | `rich_text` or `url` | Notion | reference only: an import **never** grants consent |
| Subscription status | `select` (or `status`) | **App** | options `Subscribed`, `Unsubscribed`, `Bounced`, `Complained` |
| Last emailed / Last engagement | `date` | **App** | written from M5/M7 |

Notes on Subscription status:
- A person setting `Unsubscribed`, `Bounced` or `Complained` in Notion makes the app **add a suppression**.
- Setting `Subscribed` or blank **never** removes a suppression and is never treated as consent. If a suppressed contact shows `Subscribed`, the app writes the suppressed value back.
- If you use a `status` property instead of `select`, add the four options in Notion yourself. The API cannot create status options.

## 2. Create an internal connection (formerly "integration")
A **Workspace Owner** must do this.
1. Open the Notion Developer portal: https://app.notion.com/developers/connections
2. Go to **Build → Internal connections → Create a new connection**.
3. Name it **"Email MKT Tracker (test)"** and pick the workspace.
4. On the **Configuration** tab, enable these capabilities:
   - **Read content**
   - **Update content** (needed to write Subscription status back)
   - **Insert content** (only needed if the app creates the database)
   - **User capabilities: No user information**
5. Copy the **API token** from the Configuration tab.
   - Tokens begin with `ntn_`; older ones begin with `secret_`.
   - Put it straight into a password manager. **Do not send it to anyone, including Claude.**

## 3. Share the test page with the connection
Use either method. Access is inherited by child pages and databases.
- In Notion: open the TEST page, then **••• → Connections → + Add connection** → choose "Email MKT Tracker (test)".
- In the Developer portal: open the connection, then **Content access → Edit access** → select the TEST page.

Do not share real-customer pages with the test connection.

## 4. Configure the environment (you, not the repository)
Set these on the machine or host that runs the app and the worker:
- locally, in `.env.local`, which is git-ignored;
- on a host, in its secret store.

| Variable | Value | Secret? |
|---|---|---|
| `NOTION_MODE` | `live` | no |
| `NOTION_API_BASE_URL` | leave blank (defaults to `https://api.notion.com`) | no |
| `NOTION_AUTHORIZATION_REF` | who approved connecting which database, and when, e.g. `"Approved by <name> 2026-11-20: TEST page 'Email MKT Tracker — TEST' only"` | no |
| `APP_ENCRYPTION_KEY` | 32 random bytes as base64url: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` | **yes** |
| `APP_ENCRYPTION_KEY_ID` | `k1` | no |
| `NOTION_RATE_LIMIT_RPS` | `2.5` (default; Notion allows about 3 requests per second on average) | no |

- `npm run setup:local` generates `APP_ENCRYPTION_KEY` for you locally.
- If the encryption key is lost, the stored token can no longer be decrypted, and you must re-enter it.
- The app refuses to start with `NOTION_MODE=live` unless `NOTION_AUTHORIZATION_REF` is set and the base URL is the official API.

There is **no** environment variable for the Notion token.

## 5. Connect in the app (admin)
1. Start the app and the worker. Sign in as an admin.
2. Open **Notion settings**.
3. To create the database:
   - In **Create the CRM database**, paste the token into the password field and the TEST page URL as the parent.
   - Click **Create and connect**.
4. To map an existing database:
   - In **Connect an existing database**, paste the token and the database URL. The 32-character ID before `?v=` is extracted automatically.
   - Click **Connect**.
5. Review the suggested **Field mapping**, fix any errors or warnings, and click **Save mapping**.
6. Open **Sync** and click **Full sync now**. Check the run row:
   - fetched and created counts;
   - data issues on **Data issues**.

From then on the worker runs the following on its own:
- incremental syncs every 10 minutes;
- a full reconcile nightly at 02:00 Asia/Ho_Chi_Minh;
- Notion write-backs every minute.

## 6. Verify the live connection (smoke S3-live)
Run this only after authorization, and only on the TEST database.
- [ ] The number of non-trashed rows in Notion equals "active" contacts in the app.
- [ ] Edit a test contact's name in Notion, then **Sync now**. The change appears and no new contact is created.
- [ ] Set a test contact to `Unsubscribed` in Notion, then sync. The contact is shown as suppressed, with consent **withdrawn**.
- [ ] Set the same contact back to `Subscribed`, then sync. It stays suppressed, and Notion shows `Unsubscribed` again within about a minute.
- [ ] Move a test page to the trash, then run **Full sync now**. The contact is archived.
- [ ] Record the results in `reports/<date>-<cycle>/` as **LIVE**.

## 7. Disconnecting and rotating
- **Notion settings → Disconnect** deletes the stored token. Contacts, suppressions and consent history are kept.
- To revoke access completely, also remove the connection in the Notion Developer portal, or remove it from the page's **Connections** menu.
- **Token rotation:** generate or refresh the token in the Developer portal (exact steps UNVERIFIED), then reconnect in the app.

## Known limits and unverified points
- **Request rate:** the client paces itself at 2.5 requests per second, with at most one request in flight at a time. It retries 429 and 529 responses using `Retry-After`. It retries other 5xx errors only for reads and idempotent property updates. It never retries "create database".
- **Query cap:** a single query returns at most 10,000 results. Larger databases are read in time-ordered chunks. If a chunk makes no progress, the run is marked partial and nothing is archived.
- **UNVERIFIED:** whether trashed pages appear in query results. The app handles both cases: pages returned with `in_trash` are archived, and pages missing from a complete full listing are archived.
- **UNVERIFIED:** whether `last_edited_time` is rounded to the minute. Incremental syncs re-read a 5-minute overlap either way.
- **UNVERIFIED:** extracting a page ID from a URL. Notion documents the developer toolbar ("Enable developer features") for copying IDs; the app also accepts pasted URLs.
