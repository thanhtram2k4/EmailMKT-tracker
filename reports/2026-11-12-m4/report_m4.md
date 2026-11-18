# Báo cáo kiểm thử — M4: Redesign UI/UX, personalization và gửi thử (test send)

- **Build / commit:** branch `m4-ui-testsend`, dựng từ `m3-rev2-checkpoint` (`e4ab97e`). Thay đổi M4 được commit sau chu kỳ này (xem §9); mọi lần chạy dưới đây đều trên working tree đó.
- **Môi trường:** local, Windows 11, Node 24, PostgreSQL 17 (embedded), Chromium (Playwright 1.65). Stack cô lập `scripts/local-stack.ts` (APP_ENV=test, NOTION_MODE=mock).
  - **SEND_MODE:** `disabled` (e2e, smoke) và `mock` (`e2e:mock-send`, `smoke:mock-send`). Không có chế độ gửi thật nào được bật.
- **Thời gian chạy (Asia/Ho_Chi_Minh, UTC+07:00):** baseline 15:03–15:06; lần chạy 1 15:30–15:36; lần chạy 2 15:46–15:51; lần chạy cuối (3) 15:54–15:59, ngày 2026-11-12.
- **Người chạy:** Claude Code (AI), theo yêu cầu của bạn.
- **Phạm vi được phép:** chỉ local + mock SES. **Không** gửi email thật, **không** gọi AWS, **không** deploy, **không** push, **không** Notion live.

> **Tóm tắt:** Mọi kết quả PASS dưới đây đều là **MOCK**. Chưa có email thật nào được gửi qua SES: bước LIVE (S5-live) bị **BLOCKED** cho tới khi bạn cho phép riêng. Luồng M3 Paste HTML → Import → Preview → Edit → Save → Reopen vẫn PASS nguyên vẹn trên UI mới.

## 1. Quy trình đã chạy

1. **Baseline** trên `m3-rev2-checkpoint`, trước khi sửa code: 7/7 lệnh exit 0 (e2e 33 passed; smoke 6 PASS / 2 BLOCKED / 6 NOT RUN). Xem `logs/baseline/`.
2. **Kịch bản tái hiện** OR-UI-01, OR-M3-01, OR-TS-01 được viết vào `docs/PLAN.md` **trước** khi code.
3. **Smoke pre-check**, sau đó chạy toàn bộ regression (lần 1).
4. **Lỗi:** tái hiện → sửa → chạy lại đúng case gốc → chạy lại regression liên quan.
5. **Kiểm tra đột biến (mutation):** chứng minh test bắt được lỗi thật.
6. **Xem ảnh chụp bằng mắt:** phát hiện thêm 2 lỗi, tái hiện bằng assertion rồi sửa.
7. **Chạy lại toàn bộ trên build cuối** (lần 3), gồm **re-smoke**.

Skill `ui-ux-pro-max` chỉ được dùng làm nguồn gợi ý thiết kế. Nó **không thay thế** bước nào trong quy trình trên.

## 2. Lệnh và exit code — build cuối (lần 3)

| Lệnh | Exit | Thời gian | Kết quả |
|---|---|---|---|
| `npm run smoke:local` (pre-check / re-smoke, SEND_MODE=disabled) | 0 | 30 s | 9 PASS · 3 BLOCKED · 4 NOT RUN · 0 FAIL |
| `npm run lint` | 0 | 7 s | sạch |
| `npm run typecheck` | 0 | 5 s | sạch |
| `npm run test:unit` | 0 | 4 s | 163/163 (baseline 147) |
| `npm run test:integration` | 0 | 44 s | 52/52 (gồm 15 test M4 mới) |
| `npm run test:tooling` | 0 | 20 s | 7/7 |
| `npm run e2e` (SEND_MODE=disabled) | 0 | 140 s | 47 passed, 3 skipped (3 test chỉ dành cho mock) |
| `npm run e2e:mock-send` (SEND_MODE=mock) | 0 | 35 s | 4 passed, 1 skipped (test chỉ dành cho disabled) |
| `npm run smoke:mock-send` (re-smoke, SEND_MODE=mock) | 0 | 31 s | 9 PASS · 3 BLOCKED · 4 NOT RUN · 0 FAIL |

- Log của build cuối nằm trong `logs/run3-final/`.
- Mỗi stack kết thúc với "cleanup ok: 5 owned process(es) stopped, none left".
- Sau khi chạy, các cổng 3100, 4011, 54331 và 54332 đều trống.

## 3. Kết quả theo kịch bản

| ID | Kịch bản | MOCK/LIVE | Kết quả | Ghi chú |
|---|---|---|---|---|
| OR-UI-01 | Đi qua mọi mục sidebar bằng chuột và bàn phím, với vai trò admin và member, ở 1440 và 375 px | MOCK | PASS | Qua R-UI-01/02/03/06 |
| OR-M3-01 | Paste HTML → Import → Preview → Edit → Save → Reopen → Export trên UI mới | MOCK | PASS | `paste-workflow.spec` (7 test) không đổi gì ngoài đường dẫn lưu ảnh. v2 export = v1 cộng đúng 4 thay đổi |
| M3 editor trial | `editor-trial.spec` (11 test) | MOCK | PASS | Không đổi logic editor |
| OR-TS-01 | Subject có fallback → preview → gửi thử tới địa chỉ allowlist → lịch sử | MOCK | PASS | Subject nhận được: `[TEST] Chào bạn, ưu đãi tháng 11`; trạng thái `accepted` (mock) |
| R-UI-01 | Mọi trang render cho admin, không lỗi console | MOCK | PASS | 8 trang |
| R-UI-02 | Skip link, focus nhìn thấy được, nav có `aria-current` | MOCK | PASS | |
| R-UI-03 | Không cuộn ngang ở 375/768/1024/1440 px, kể cả trang editor và chi tiết contact | MOCK | PASS | Lần đầu FAIL, xem §5 |
| R-UI-04 | axe: 0 vi phạm serious/critical, light và dark (WCAG 2.1 AA tags) | MOCK | PASS | Lần đầu FAIL, xem §5. `metrics/axe-summary.json` |
| R-UI-05 | `prefers-reduced-motion` tắt transition | MOCK | PASS | |
| R-UI-06 | Không có link `/internal`; member không thấy mục admin, vào trang admin thì nhận trang forbidden | MOCK | PASS | |
| Theme | Toggle sáng/tối/hệ thống được giữ qua reload (cookie, render phía server) | MOCK | PASS | |
| R-PERS-01 | Thiếu greeting → fallback ở cả subject và body | MOCK | PASS | unit + e2e |
| R-PERS-02 | Dấu tiếng Việt đúng; subject là text thuần (không escape HTML) | MOCK | PASS | unit |
| R-PERS-03 | Field/filter lạ, lỗi cú pháp, hoặc thiếu giá trị mà không có fallback → chặn gửi thử | MOCK | PASS | unit + integration + e2e |
| R-PERS-04 | Gửi thử không bao giờ vào số liệu campaign | MOCK | PASS (phần cấu trúc) | `test_sends` không có `campaign_id`. Phần open/click: **NOT RUN** (tracking thuộc M7) |
| R-PERS-05 | Liệt kê đúng contact bị thiếu giá trị | MOCK | PASS | integration. E2E chỉ chạy được khi stack đã có contact (xem §6) |
| R-PERS-06 | `{% %}` trong subject không được thực thi | MOCK | PASS | unit |
| R-PERS-07 | Xuống dòng trong subject hoặc trong giá trị merge bị từ chối (chống header injection) | MOCK | PASS | unit; `SES_FROM_ADDRESS` có CRLF cũng bị từ chối khi khởi động |
| R-TS-01 | Ma trận guard × môi trường × SEND_MODE, gồm factory | MOCK | PASS | unit. Factory vẫn từ chối customer campaign (M5) |
| R-TS-02 | Địa chỉ ngoài allowlist bị server từ chối, không lộ danh sách | MOCK | PASS | integration + e2e (UI) |
| R-TS-03 | Địa chỉ bị suppress bị từ chối dù có trong allowlist | MOCK | PASS | integration |
| R-TS-04 | Bấm gửi 2 lần đồng thời với cùng key → provider chỉ bị gọi 1 lần | MOCK | PASS | integration, real PostgreSQL |
| R-TS-05 | Timeout → `unknown`, không tự retry; "Gửi lại" tạo dòng mới có liên kết | MOCK | PASS | unit (timeout thật qua AbortController) + integration. DB chặn `unknown → claimed` |
| R-TS-06 | Ánh xạ lỗi SES: rejected / throttled / credentials / 5xx / mất kết nối | MOCK | PASS | unit, fake client |
| R-TS-07 | Tiền tố `[TEST]`, tag `msg_id`/`purpose`, header, UTF-8 | MOCK | PASS | unit + integration |
| R-TS-08 | Rate limit theo người (refusal không bị tính) | MOCK | PASS | integration |
| R-TS-09 | `test_sends` không có liên kết campaign | MOCK | PASS | integration (information_schema) |
| R-TS-10 | Reaper: `claimed` quá 10 phút → `unknown`, không gửi lại | MOCK | PASS | integration, clock điều khiển được |
| R-TS-11 | Audit chỉ chứa địa chỉ đã che (`q***@example.com`) | MOCK | PASS | integration |
| R-TS-12 | SEND_MODE=disabled: nút tắt và server từ chối | MOCK | PASS | integration + e2e + smoke S5-disabled |
| S1–S3, S4-m3 | Smoke cũ | MOCK | PASS | Không đổi so với baseline |
| S4 | Subject + body với contact CRM (synthetic) thiếu greeting → không còn field chưa resolve | MOCK | PASS | `subject="Chào bạn — bản tin"` |
| S5-disabled / S5-mock | Gửi thử bị từ chối khi disabled / được `accepted` in-process khi mock | MOCK | PASS | mock: 1 lần gọi transport, không có network |
| S10 | 8 trang sidebar trả 200 và có `<main id="main">` | MOCK | PASS | |
| **S5-live** | Gửi thật qua SES tới hộp thư allowlist / SES simulator; sự kiện Delivery | LIVE | **BLOCKED** | Chưa được phép; chưa có SES, credentials, `SEND_AUTHORIZATION_REF`; sự kiện Delivery cần SNS + HTTPS công khai |
| S2-live, S3-live | Google OAuth, Notion live | LIVE | BLOCKED | Như M1/M2 |
| S6–S9 | Send now, lịch gửi, tracking, huỷ | — | NOT RUN | M5–M7 |
| Hiển thị trong Gmail/Outlook/mobile | | LIVE | NOT RUN | Chưa được phép gửi |

## 4. Kiểm tra đột biến (mutation check)

- **Đột biến:** tạm vô hiệu hoá kiểm tra allowlist trong `src/lib/sending/test-send.ts`.
- **Kết quả:** `test-send.test.ts` **exit 1**, 3 test FAIL (R-TS-02, R-TS-08, R-TS-11). Mutant bị bắt.
- File đã được hoàn nguyên và xác nhận giống hệt bản gốc bằng `cmp`. Log: `logs/retests/mutation-allowlist.log`.

## 5. Lỗi phát hiện, tái hiện, sửa và chạy lại (giữ nguyên lần FAIL đầu)

| # | Phát hiện ở | Lỗi (lần đầu) | Phân loại | Tái hiện | Sửa | Chạy lại case gốc | Regression |
|---|---|---|---|---|---|---|---|
| D1 | Lần 1, R-UI-03 | `/contacts/issues` rộng hơn 375 px thêm 139 px | Lỗi UI thật | Có (log `run1-first/e2e.log`) | Bọc bảng trong `.table-wrap` | PASS | Lần 3 PASS |
| D2 | Lần 1, R-UI-04 | axe `scrollable-region-focusable` ở `/sync .table-wrap` | Lỗi a11y thật | Có | `.table-wrap` có `tabIndex={0}` và focus ring | PASS | Lần 3 PASS |
| D3 | Retest D1–D2 (test được sửa để quét đủ mọi trang) | `/sync` +111 px, `/settings/notion` +71 px | Lỗi UI có từ trước (M2), trước đó bị che vì test dừng ở trang lỗi đầu tiên | Có (`retests/ui.log`) | Bọc các bảng còn lại | PASS | Lần 3 PASS |
| D4 | Như D3 | axe `select-name`: các `select` mapping Notion không có nhãn | Lỗi a11y có từ trước (M2) | Có | `aria-label` cho từng select | PASS | Lần 3 PASS |
| D5 | Retest | `/settings/notion` +9 px (flex item `min-width: auto`) | Lỗi UI | Có (`retests/ui-2.log`) | `.table-wrap { min-width: 0 }` | PASS | Lần 3 PASS |
| D6 | Test mới cho editor | Editor +163 px ở 375 px do `select[preview-mode]` có tên người nhận dài | Lỗi UI | Có (`retests/ui-5.log`) | CSS: label/select trong `.row` được phép co lại | PASS | `paste-workflow` + `editor-trial` lần 3 PASS |
| D7 | Xem ảnh chụp bằng mắt (test chưa bắt) | Nút menu (drawer) hiện cả trên desktop | Lỗi UI (thứ tự CSS: `.btn` ghi đè `display:none`) | Có, bằng assertion mới → FAIL (`retests/visual-repro.log`) | `.btn.menu-toggle` chỉ hiện ≤ 860 px | PASS | Lần 3 PASS; drawer 375 px vẫn PASS |
| D8 | Xem ảnh chụp bằng mắt | Ô Subject bị kéo cao (flex-basis theo chiều dọc) | Lỗi UI | Assertion chiều cao < 60 px được thêm cùng lúc với D7 (test dừng ở D7 nên chưa quan sát riêng D8 FAIL) | `.subject-card input { flex: none }` | PASS | Lần 3 PASS |
| T1 | Lần 1, `e2e:mock-send` | Test personalization cần contact đã sync (do `crm.spec` tạo); stack mock-send không có contact | **Lỗi ở test** (phụ thuộc thứ tự chạy) | Có | Test tự kiểm tra điều kiện, ghi annotation; R-PERS-05 do integration đảm nhận | PASS | Lần 3 PASS |
| T2 | Trước chu kỳ (dev) | Integration test-send: 15 FAIL do `TRUNCATE` vào bảng append-only `suppressions` (trigger đã chặn đúng như thiết kế) | Lỗi ở test | Có | Chỉ truncate `test_sends` | PASS | |
| T3 | Trước chu kỳ | 2 FAIL: drizzle bọc lỗi trigger trong `cause`; audit log tích luỹ qua nhiều test | Lỗi ở test | Có | Sửa assertion; lọc theo correlation id | PASS | |
| C1 | Trước chu kỳ | 3 unit test config FAIL | **Thay đổi hành vi có chủ đích** (SEND_MODE thật giờ bắt buộc có `SES_FROM_ADDRESS`) | Có | Cập nhật test và thêm test cho quy tắc mới | PASS | |

Ghi chú về D8: tôi không quan sát được D8 FAIL riêng trước khi sửa, nên đây chỉ là "lỗi thấy trên ảnh, đã sửa, đã kiểm tra lại", không phải một lần tái hiện tự động.

## 6. Lịch sử test flaky / điều kiện

- Không có test flaky nào trong 3 lần chạy đầy đủ (retries = 0).
- Test "subject preview…" trong `e2e:mock-send` chạy nhánh "không có contact" (annotation `precondition`): danh sách contact bị ảnh hưởng **không** được kiểm trên UI trong stack đó. Ở stack mặc định thì có kiểm (PASS), và integration R-PERS-05 bao phủ logic.

## 7. Chưa kiểm / bị chặn

- **Gửi thật qua SES (S5-live):** BLOCKED. Cần lần lượt:
  1. bạn cho phép riêng;
  2. thiết lập SES theo checklist trong kế hoạch: identity đã verify, sandbox thì verify cả địa chỉ nhận, IAM tối thiểu, AWS profile;
  3. điền `.env.local`: `SEND_MODE=allowlist`, `TEST_RECIPIENT_ALLOWLIST`, `SEND_AUTHORIZATION_REF`, `SES_FROM_ADDRESS`, `AWS_PROFILE`.
- **Delivered/Bounce cho gửi thử:** cần configuration set + SNS + endpoint HTTPS công khai, tức là phải deploy (chưa được phép). "Accepted" của SES **không** chứng minh thư đã vào inbox.
- **Nút "Kiểm tra SES"** (GetAccount, chỉ đọc): chưa được bấm thật (đúng như yêu cầu: không gọi AWS). Nút này chỉ bật khi đã cho phép gửi thật.
- Hiển thị email trong Gmail/Outlook/mobile: NOT RUN. Chỉ kiểm bằng trình duyệt Chromium.
- Preheader: đã có cột trong DB nhưng **chưa** dùng khi gửi và chưa có trên UI.
- Firefox/Safari: chưa kiểm. Chỉ dùng Chromium.
- Tiếng Việt hoá toàn bộ UI: ngoài phạm vi. Các chuỗi tiếng Anh mà test đang assert được giữ nguyên. Nav, theme và panel gửi thử dùng một phần tiếng Việt.
- Điểm thẩm mỹ nhỏ: bảng lịch sử gửi thử trong thẻ nửa trang bị xuống dòng chữ (WHEN/SUBJECT). Không phải lỗi chức năng.
- `npm audit`: 4 lỗ hổng mức moderate trong công cụ dev (`drizzle-kit` → `esbuild`), có từ trước, không đến từ dependency mới.
- Trên máy còn các tiến trình từ **trước** phiên này (node trên :3000 và :4010, postgres trên :54321, khởi động lúc 13:39–13:40). Tôi **không** dừng chúng, vì chúng không do tôi tạo.

## 8. Ảnh chụp và bằng chứng

- `screenshots/ui/`: dashboard và contacts (light/dark), editor ở 1440 px, editor/Emails/drawer ở 375 px, sign-in.
- `screenshots/test-send/`: trạng thái disabled, mock accepted, mock refused, personalization check.
- `screenshots/paste-workflow/`: luồng M3 trên UI mới. Ảnh bằng chứng của M3 rev 2 **không** bị ghi đè; đường dẫn giờ lấy từ `PASTE_WORKFLOW_SHOTS`.
- `metrics/axe-summary.json`, `metrics/smoke-results-*.md`.
- `logs/`:
  - `baseline/`, `run1-first/` (lần FAIL đầu được giữ nguyên);
  - `retests/` (tái hiện, retest, mutation);
  - `run3-final/`.
- **Redaction:** đã quét logs/metrics tìm token, cookie phiên, AKIA, secret và địa chỉ email: không có secret. Chỉ có địa chỉ fixture ở domain dành riêng (`example.com/org/net`, `*.example`, simulator). Báo cáo không tự gửi cho ai.

## 9. Khuyến nghị

- **Phần MOCK của M4 đã sẵn sàng để bạn review:** UI mới, personalization đầy đủ, và gửi thử với mock/fake SES. Toàn bộ suite trên build cuối exit 0, và luồng M3 không bị ảnh hưởng.
- **Chưa thể tuyên bố "gửi thử qua SES hoạt động".** Điều đó chỉ được chứng minh sau bước LIVE (S5-live), và bước này cần bạn cho phép riêng.
- **Checkpoint:** commit cục bộ trên `m4-ui-testsend`, tag `m4-checkpoint`. Không push, không remote.
