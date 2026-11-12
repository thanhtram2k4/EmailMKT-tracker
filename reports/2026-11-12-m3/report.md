# Báo cáo kiểm thử: M3 — Thử nghiệm trình soạn thảo email (editor trial)

| | |
|---|---|
| Build | `src-071125b4e5f2`: mã băm nội dung của cây làm việc trên nhánh `m3-editor-trial`, tách từ `m2-checkpoint` (`63cad42`). Commit checkpoint M3 ở cuối báo cáo |
| Môi trường | Windows 11 Pro 10.0.26300 · Node v24.18.1 · PostgreSQL 17.10 (embedded) · Next.js 16.4.6 (production build) · Playwright 1.65.0 / **Chromium headless** · mock Notion |
| Cấu hình | `APP_ENV=test` · **`SEND_MODE=disabled`** · `NOTION_MODE=mock` |
| Thời điểm chạy cuối | 2026-11-12 05:37:23Z – 05:41:20Z = **12:37 – 12:41 (Asia/Ho_Chi_Minh, UTC+07:00)** |
| Phạm vi | Không gửi email, không deploy, không truy cập Notion thật. **Không có trình đọc mail thật nào (Gmail, Outlook, ứng dụng di động) được kiểm thử.** |

## 1. Đầu vào của thử nghiệm

| Đầu vào | Nguồn | Trạng thái |
|---|---|---|
| **Template thật #1 (ứng viên)** | `C:\Users\Admin\Downloads\wildcats-email-gmail.html` · 29.431 byte · SHA-256 `3c781d16586148f2522473b2841d41d4f6bd46afbf488768737ead431d6b4422` · tiêu đề "Wildcats Email – Wink Venue Partner" | Tìm thấy ngoài thư mục dự án. **Bạn chưa xác nhận đây là template bạn muốn cung cấp.** Bản sao để thử nằm trong `.local/real-templates/` (Git bỏ qua). **Không commit nội dung hay ảnh chụp** của file này; báo cáo chỉ chứa số liệu. |
| **Template thật #2** | Không tìm thấy (đã tìm trong dự án, `D:\AI Studio`, Downloads, Desktop, Documents) | **BLOCKED** |
| Template TỔNG HỢP A | `fixtures/email-templates/synthetic-a-newsletter.html` | Mô phỏng HTML dạng bảng xuất từ trình tạo email: XHTML doctype, 6 dấu comment MSO, nút VML, `<style>` có `@media`, preheader ẩn, 6 trường trộn có fallback |
| Template TỔNG HỢP B | `fixtures/email-templates/synthetic-b-promo-hazards.html` | Bố cục cột bằng `div` và cố ý chứa mã nguy hiểm: `<script>`, `onerror`/`onclick`/`onload`, `javascript:`, `<form>`, `<iframe>`, `<object>`, `<svg><script>`, meta refresh, CSS `url(javascript:)`. Có ảnh tương đối, ảnh http, pixel theo dõi, liên kết giả mạo tên miền, trường trộn sai và trường không có fallback |

Template thật #1 là một **trang công cụ** bọc email bên trong `#email`; phần ngoài có `<script>`, 14 `<input>`, `<select>` và `<button>`. Vì vậy nó được nhập với bộ chọn `#email`, đúng như chú thích trong chính file đó: "Email nằm trong #email".

## 2. Các ứng viên theo kế hoạch đã được thử

| | Ứng viên trong kế hoạch | Cách thử |
|---|---|---|
| (a) | **Editor giữ nguyên cấu trúc (click-to-edit)**, tự xây: cheerio ở chế độ htmlparser2, khung xem trước sandbox | Ứng dụng hoàn chỉnh trong `/templates/[id]` |
| (b) | **GrapesJS 0.23.9 + grapesjs-preset-newsletter 1.0.2** (BSD-3) | Trang thử `/templates/[id]/grapesjs`: phần `<head>` gốc được giữ và ghép lại, body do GrapesJS xuất (inline CSS) |
| (c) | **TipTap 3.33.1** (MIT) để dán văn bản có định dạng | Dùng làm trình soạn thảo của từng khối văn bản bên trong (a); thử dán HTML giống Google Docs |

Unlayer và Beefree không được thử: đều trả phí và chuyển HTML sang JSON riêng, đúng như kế hoạch đã loại.

## 3. Kết quả theo từng template

Mọi số liệu hiển thị đều lấy từ **Chromium** qua Playwright, ở 640px và 375px. Đây **không phải** kết quả của Gmail, Outlook hay ứng dụng mail trên di động.

### Template TỔNG HỢP A (bảng, MSO, VML, @media)

| Hạng mục | Kết quả |
|---|---|
| Nhập và làm sạch | Không có gì nguy hiểm. Giữ **6/6** dấu MSO, nút VML, doctype và trường trộn. Chỉ bỏ 1 comment thường (nhãn "SYNTHETIC") |
| Vùng sửa được | 14: 6 văn bản (kể cả preheader ẩn), 4 ảnh, 1 nút, 3 liên kết |
| Sửa trên trình duyệt | **Văn bản** (thêm câu và một trường trộn qua bộ chọn), **ảnh** (src và alt), **nút** (chữ và đường dẫn có `{{ email \| url_encode }}`), **liên kết** (href): **PASS** |
| Lưu → mở lại → xuất | v2 chứa đủ 4 chỉnh sửa. Trường trộn 6 → 7: giữ đủ 6 cũ, thêm 1. MSO 6 → 6. Không còn `data-emt-id`. Bản plain text cũng có chỉnh sửa: **PASS** |
| Định dạng bị mất | Khi sửa đoạn "Kính gửi…" bằng TipTap, **mất 1 `<span>` màu** ("giảm 15%" xanh, đậm); số span có style đi từ 1 về 0. **Editor đã cảnh báo trước khi sửa.** |
| Hiển thị gốc → v1 (sau khi nhập) | **0,00%** điểm ảnh ở 640px và 375px, chiều cao giữ nguyên |
| Xem trước theo người nhận | Mẫu đủ thông tin → "Anh An"; thiếu tên gọi → "**Quý khách**"; thiếu công ty → "**quý công ty**". Không có trường nào thiếu mà không có fallback |
| Kiểm tra ảnh và liên kết | 4 lỗi ảnh: đường dẫn `/fixtures/...` tương đối theo gốc. Xem trước trong app vẫn tải được, nhưng **trong email thật sẽ không tải** và phải chuyển sang https tuyệt đối (lưu trữ S3 thuộc M3 sau). Ngoài ra có thông tin về MSO và `@media` |
| **GrapesJS**, xuất không sửa | Giữ MSO 6/6, VML và trường trộn. Nhưng **thêm 24 thuộc tính `id`**, kích thước 5.994 → 10.720 byte (inline CSS), hiển thị **0% ở 640px nhưng 2,91% ở 375px** (chân trang dịch lên 10px). Sửa và lưu qua GrapesJS: giữ chỉnh sửa, trường trộn và MSO |

### Template TỔNG HỢP B (cột div, mã nguy hiểm)

| Hạng mục | Kết quả |
|---|---|
| Làm sạch | Đã loại: `script`×2, `iframe`, `object`, `form`, `input`, `button`, `svg`; 3 thuộc tính sự kiện; 1 liên kết `javascript:`; meta refresh; 1 CSS `url(javascript:)`. Giữ link font https (có cảnh báo) và ảnh `data:` (có đánh dấu) |
| Vùng sửa được | 18: 8 văn bản, 4 ảnh, 5 liên kết, 1 nút |
| Sửa 4 loại, lưu, mở lại, xuất | **PASS**, sau khi sửa lỗi F6 (nút không được nhận diện) |
| Trường trộn | `{{ ten_khach }}` → lỗi "trường không tồn tại"; `defaul:` → lỗi "bộ lọc không tồn tại"; `{{greeting_name}}` không có fallback → với người nhận thiếu tên, app báo "**Missing values without fallback: greeting_name**". Các trường lỗi được để nguyên trong bản xem trước để dễ thấy |
| Kiểm tra | Ảnh tương đối, ảnh http, CTA http, pixel theo dõi của bên thứ ba, liên kết hiển thị "www.ngan-hang-that.example" nhưng trỏ tới "shop.example", "Hủy đăng ký" trỏ tới `#`, thiếu `alt`: **đều được phát hiện** |
| Ảnh trong xem trước | "**2 image(s) failed to load**" (ảnh tương đối và ảnh http) — đúng |
| Hiển thị gốc → v1 | 0,80% ở 640px, 0,74% ở 375px. Phần khác biệt chính là các phần tử nguy hiểm đã bị loại (form, iframe, svg) |
| **GrapesJS**, xuất không sửa | **13,81% ở 640px, cao thêm 44px: bố cục 2 cột bị xếp chồng thành 1 cột trên máy tính**, nền và khoảng đệm của khung bao bị đổi (ảnh `B-gjs-base-640.png` so với `B-gjs-noedit-640.png`). Thêm 16 `id` |

### Template thật #1, ứng viên (chỉ số liệu)

| Hạng mục | Kết quả |
|---|---|
| Nhập (`#email`) | Tìm thấy `#email`. Không có MSO, trường trộn hay ảnh bên trong `#email`. Giữ doctype |
| Vùng sửa được | **62**: 60 văn bản, 2 liên kết. Không có vùng ảnh hay nút, nên **sửa ảnh và nút: KHÔNG ÁP DỤNG** cho template này |
| Sửa văn bản (thêm trường trộn) và liên kết; lưu → mở lại → xuất | **PASS**. Trường trộn 0 → 1 (vừa thêm), các span có style giữ nguyên 3 → 3 |
| Hiển thị `#email` gốc → v1 | **0,00%** ở 640px và 375px |
| Responsive | Email **cố định rộng 600px**: ở khung 375px trang vẫn rộng 600px (tràn ngang), **cả bản gốc lẫn bản đã nhập**. Đây là đặc điểm của template. Ứng dụng mail di động thường tự thu nhỏ, nhưng **CHƯA kiểm chứng** |
| Kiểm tra | Cảnh báo: không có liên kết hủy đăng ký. Thông tin: có `@media` |
| **GrapesJS**, xuất không sửa | **6,98% ở 640px, 7,44% ở 375px**, cao thêm 22px (từ khoảng điểm ảnh 713 trở xuống). **Thêm 91 `id`**, 17,3 → 32,1 KB |

### TipTap: dán văn bản định dạng (dữ liệu clipboard tổng hợp, giống Google Docs)

- **Giữ được:** đậm (từ `font-weight:700`), nghiêng, liên kết.
- **Bỏ đi:** màu, cỡ chữ, phông chữ.
- **Thêm vào:** `<u>` cho liên kết có gạch chân. TipTap mặc định gắn `target="_blank" rel="noopener noreferrer nofollow"` cho liên kết; nên cấu hình lại cho email.

Kết quả: **PASS**, chi tiết trong `metrics/tiptap-paste.json`.

### Hiển thị trên trình đọc mail thật

| Gmail web/Android/iOS · Outlook desktop/web · Apple Mail iOS · Litmus/Email on Acid | **NOT RUN** |
|---|---|

Lý do: `SEND_MODE=disabled`, không có hộp thư thử và chưa được phép gửi. **Mọi kết luận về hiển thị trong báo cáo chỉ áp dụng cho Chromium.**

## 4. Đề xuất editor (TẠM THỜI)

**Đề xuất:** dùng **(a) editor giữ nguyên cấu trúc** cho HTML nhập từ trình tạo email, với **(c) TipTap** cho nội dung từng khối văn bản và việc dán văn bản. **Không dùng (b) GrapesJS** cho template nhập vào.

Bằng chứng:
1. Nhập và lưu lại không sửa gì cho ra HTML giống hệt gốc. Chỉ có 3 khác biệt hình thức đã được ghi lại: `<br />` → `<br>`, nháy đơn → nháy kép, thuộc tính không giá trị → `=""`. Hiển thị trong Chromium **0,00%** với A và template thật.
2. Chỉ nút được sửa mới thay đổi (unit test so sánh toàn văn bản). MSO, VML, doctype và trường trộn được giữ qua sửa, lưu và mở lại.
3. GrapesJS làm thay đổi hiển thị ngay cả khi không sửa gì: 2,91%, 13,81% và 7,44%. Nó phá bố cục cột của B, thêm hàng chục `id`, và gần như gấp đôi kích thước do inline CSS.

Giới hạn của đề xuất:
- Sửa một khối bằng TipTap sẽ bỏ định dạng nội dòng mà TipTap không biểu diễn được (span màu, `<font>`). Editor có cảnh báo, nhưng nên bổ sung chế độ "chỉ sửa chữ, giữ nguyên định dạng".
- Không có kéo-thả bố cục. GrapesJS có thể xem lại ở Phase 2 cho email **tạo mới**, nếu vượt qua kiểm thử trên trình đọc mail thật.
- Template thật có tới 60 vùng văn bản; cần thử khả năng dùng với người dùng thật.
- Ảnh tải lên phải được lưu ở URL https công khai (S3).

**Tại sao là tạm thời:** chỉ có 1 template thật, và là ứng viên chưa được bạn xác nhận; template #2 bị BLOCKED; chưa có kiểm thử trên Gmail, Outlook hay di động.

## 5. Lệnh đã chạy (chu kỳ cuối)

| Lệnh | Exit | Thời gian | Kết quả |
|---|---|---|---|
| `npm run lint` | 0 | 9 s | sạch |
| `npm run typecheck` | 0 | 7 s | sạch |
| `vitest --project unit` | 0 | 4 s | **124/124** (99 từ M1–M2, 25 template mới) |
| `vitest --project integration` | 0 | 48 s | **37/37** (hồi quy M1–M2) |
| `vitest --project tooling` | 0 | 23 s | **7/7** (mới: mã thoát và dọn tiến trình) |
| `npm run e2e` | 0 | 115 s | **31/31**: 15 hồi quy M1–M2, 15 thử nghiệm editor, 1 dán TipTap. "cleanup ok: 5 owned process(es) stopped, none left" |
| `npm run smoke:local` | 0 | 31 s | S1, S2a–c, S3-mock, **S4-m3** PASS · S2-live, S3-live BLOCKED · S4 (đầy đủ), S5–S9 NOT RUN |

Sau chu kỳ, kiểm tra trên máy cho thấy **0 tiến trình còn chạy và 0 cổng dev đang mở**.

## 6. Hồi quy cho các lỗi công cụ từ M1/M2 (yêu cầu trước khi làm M3)

| Lỗi gốc | Test hồi quy | Chứng minh test bắt được lỗi |
|---|---|---|
| Lần chạy test thất bại vẫn thoát 0 (hook của embedded-postgres) | `tests/tooling/exit-code.test.ts`: test cố ý thất bại → **mã thoát ≠ 0**; test đạt → 0; có Postgres thật khởi động và dừng (không lỗi `done is not a function`); thêm một ca đặc tả hành vi gốc của thư viện | Tạm gỡ bản sửa → test "deliberately failing" **thất bại** (`first-runs/mutation-exitcode.log`), rồi khôi phục |
| Tiến trình con sót lại sau khi dừng | `scripts/lib/owned-processes.ts` chỉ nhắm vào **PID do lần chạy tạo ra và cây con của chúng** (không bao giờ dừng theo tên hay cổng). `tests/tooling/process-cleanup.test.ts`: dừng cả tiến trình cháu; tiến trình "người ngoài" **không bị đụng tới**; chỉ dừng gốc được chỉ định. `local-stack` dùng cơ chế này và **báo lỗi nếu còn tiến trình sót** | Tạm cho dừng chỉ tiến trình gốc → test **thất bại** (`first-runs/mutation-cleanup.log`), rồi khôi phục |

## 7. Lỗi phát hiện, sửa và kiểm lại (giữ nguyên lần thất bại đầu)

| # | Phát hiện bởi | Lần đầu | Nguyên nhân | Sửa | Kiểm lại |
|---|---|---|---|---|---|
| F1 | Chạy thử thư viện (số đếm MSO lệch: 5 khối với 6 dấu) | **Lỗ hổng:** HTML giữa `<!--[if !mso]><!-- -->` và `<!--<![endif]-->` **bỏ qua bộ làm sạch** | Regex gộp cả đoạn thành một khối "được bảo vệ" | Hai dấu mở/đóng được bảo vệ riêng; nội dung giữa vẫn qua bộ làm sạch | Unit test REGRESSION PASS; MSO 6/6 |
| F2 | Unit (`unit-templates-run1.log`) | `alt=""` bị xuất thành `alt` | Mặc định của dom-serializer | `emptyAttrs: true` (đánh đổi: `nowrap` → `nowrap=""`) | PASS |
| F3 | Như trên | Chữ "Gửi" của `<button>` trong form bị xoá vẫn còn | `disallowedTagsMode: discard` giữ lại văn bản | Thêm `button`, `select` vào `nonTextTags` | PASS |
| F4 | E2E (`e2e-run1.log`) | Bộ chọn `link "v1"` khớp 2 phần tử | **Lỗi test** | `exact: true` | PASS |
| F5 | E2E (`e2e-editor-run2.log`) | Plain text: `{{ full_name }}` thành `{{ FULL_NAME }}` | `html-to-text` viết HOA tiêu đề | Tắt viết hoa cho h1–h6 và th | Unit REGRESSION PASS |
| F6 | E2E và tái hiện | B **không có vùng nút**; test đã **âm thầm bỏ qua** việc sửa nút | `<a class="cta">` nằm một mình trong `<p>` nên bị coi là văn bản; sửa bằng TipTap sẽ làm mất kiểu dáng nút | Container chỉ chứa nút thì không là vùng văn bản; liên kết dạng nút trong văn bản = button; E2E **bắt buộc** phát hiện nút | Unit và E2E PASS; kiểu dáng CTA được giữ |
| F7 | Đo điểm ảnh (A gốc → v1: 5,46%, cao 943 → 1303px) | **Doctype bị mất** nên trình duyệt chuyển sang chế độ quirks | `sanitize-html` bỏ `<!DOCTYPE>` | Giữ doctype gốc | **0,00%**; unit REGRESSION PASS |
| F8 | Xem ảnh chụp | Ảnh fixture không tải khi render bằng `setContent` | **Lỗi cách đo:** cookie SameSite không được gửi từ `about:blank`, và `/fixtures` đang yêu cầu đăng nhập | Mở công khai `/fixtures` (ảnh tổng hợp) | Đo lại; các con số trên là sau khi sửa |
| — | Lint | Fixture `.cjs` dùng `require()` | Quy tắc lint | Đổi sang `.mjs` | PASS |

Không quan sát thấy test chập chờn (flaky).

## 8. Quyết định về consent (bạn xác nhận ở M3)

Liên hệ có consent **unknown** vẫn **không đủ điều kiện** gửi marketing theo mặc định (`crm.require_marketing_consent=true`), nhưng **vẫn được quản lý trong CRM**: hiển thị trong danh sách, có trang chi tiết, có thể ghi nhận consent. Bằng chứng từ hồi quy M2 trong chu kỳ này: E2E "39 active" và form consent; unit `eligibility`.

## 9. Còn chặn và chưa chạy

- **Template thật #2: BLOCKED.** Template #1 cần bạn xác nhận.
- **Hiển thị trên Gmail, Outlook, di động: NOT RUN.** Cần cho phép gửi thử tới hộp thư được chỉ định (`SEND_MODE=allowlist` cùng `SEND_AUTHORIZATION_REF`), hoặc dùng Litmus/Email on Acid.
- **Lưu trữ ảnh (S3 hoặc https):** chưa làm. Ảnh tương đối được phát hiện nhưng chưa được chuyển lưu trữ.
- Các mục còn lại từ M1/M2: Google OAuth, staging, CI, Notion thật (BLOCKED / NOT RUN).

## 10. Bảo vệ dữ liệu trong bằng chứng

- Log đã qua `redactText` và kiểm tra thủ công: không có token, cookie, khoá, email chưa che, hay nội dung template thật (đã quét theo tên thương hiệu).
- Ảnh chụp chỉ có template tổng hợp. Ảnh của template thật chỉ nằm trong `test-results/` trên máy.
