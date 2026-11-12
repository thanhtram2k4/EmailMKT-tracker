# Báo cáo kiểm thử: M3 rev 2 — Luồng dán HTML và sửa chữ giữ định dạng

| | |
|---|---|
| Nhánh | `m3-editor-trial`, tiếp nối `m3-checkpoint` (`10ac055`). Commit và tag checkpoint mới ở mục 7 |
| Môi trường | Windows 11 Pro 10.0.26300 · Node v24.18.1 · PostgreSQL 17 (embedded) · Next.js 16.4.6 (production build) · Playwright 1.65.0 / **Chromium headless** · mock Notion |
| Cấu hình | `APP_ENV=test` · **`SEND_MODE=disabled`** · `NOTION_MODE=mock` |
| Thời điểm chạy cuối | 2026-11-12, **13:21 – 13:30 (Asia/Ho_Chi_Minh, UTC+07:00)** |
| Phạm vi | Không gửi email, không deploy, không truy cập Notion thật. **Không tìm kiếm template trên máy của bạn.** |

## 1. Yêu cầu đã sửa và những gì thay đổi

Luồng chính của bạn là: **Dán HTML → Import → Xem trước → Sửa chữ/ảnh/liên kết → Lưu → Mở lại**. Yêu cầu "hai template thật" đã được rút lại, nên không còn là điều kiện để hoàn thành M3.

| # | Yêu cầu | Đã làm |
|---|---|---|
| 1 | Ô "Paste HTML" và nút Import là lối vào chính | Trang **Emails** (trước đây là Templates) mở đầu bằng ô **Paste HTML** lớn và nút **Import**. Tên là tuỳ chọn; mặc định lấy từ `<title>` của email. Tải file lên vẫn có, nhưng nằm trong "More import options" |
| 2 | Email bình thường không cần CSS selector | Toàn bộ tài liệu được nhập, gồm doctype, `<head>`, `<style>` và comment MSO. Ô selector chỉ còn trong "More import options", dành cho email nhúng trong một trang web khác |
| 3 | Bỏ nút nhập fixture và GrapesJS khỏi giao diện chính | Đã bỏ. Fixture có nhãn và công cụ so sánh GrapesJS chuyển sang `/internal/editor-lab`: chỉ admin vào được, chỉ khi `APP_ENV` là local hoặc test (môi trường khác trả 404), và không có liên kết nào từ giao diện chính |
| 4 | Lưu và mở lại email của chính bạn; không cần bộ sưu tập template | Mục "Your emails" liệt kê những email bạn đã nhập. Mỗi lần lưu tạo một phiên bản mới, không ghi đè được; phiên bản cũ vẫn mở lại được. Mỗi phiên bản có ghi chú tóm tắt nội dung đã sửa |
| 5 | Sửa chữ không làm mất định dạng; khi không giữ được thì có lựa chọn thay thế an toàn | Xem mục 2 |
| 6 | Giữ nguyên bộ làm sạch HTML và các test của nó | Mọi lần import và lưu vẫn qua bộ làm sạch. Bộ làm sạch cho từng khối chữ giờ cho phép đúng các thẻ inline mà bộ làm sạch tài liệu cho phép (`<font>`, `class`, `style` trên `<strong>`), để tránh tự xoá định dạng hợp lệ. Mọi thứ nguy hiểm vẫn bị loại. Các test bảo mật cũ đều đạt, và có thêm test mới (mục 4) |

## 2. Sửa chữ có giữ định dạng

**Trước đây (M3 lần 1):** sửa một khối chữ bằng TipTap làm mất `<span>` có màu, kèm một cảnh báo chung chung.

**Bây giờ có ba cách sửa. Cách mặc định không làm mất định dạng:**

1. **Sửa trực tiếp trong preview (mặc định).** Bấm vào chữ trong preview rồi gõ. Nếu chỉ chữ thay đổi, máy chủ chỉ ghi lại các *text node*: mọi thẻ, thuộc tính, style, màu, font, liên kết và trường trộn xung quanh được giữ **nguyên từng byte**.
   - Panel báo "✓ Only the text changed. All formatting is kept."
   - Chữ gõ vào luôn được lưu dưới dạng chữ. Ví dụ, gõ `<b>` sẽ lưu thành `&lt;b&gt;`, không thành thẻ.
   - Dán chỉ chèn chữ thuần; phím Enter thêm `<br>`; phím tắt định dạng bị tắt.
2. **Khi một thao tác làm mất định dạng**, ví dụ chọn hết khối rồi gõ đè làm biến mất `<span>` màu đỏ và `<font>`, editor **dừng lại**:
   - Nó liệt kê chính xác định dạng bị mất, ví dụ `<span style="color:#c0392b;font-weight:bold"> around "GIẢM 30%"`.
   - Nút **Save bị khoá** cho đến khi bạn chọn một trong ba cách:
     - **Undo changes to this block:** trả khối về đúng như cũ;
     - **Keep this change:** giữ thay đổi, và phiên bản ghi lại "formatting removed (accepted): …";
     - **Edit HTML source instead:** tự sửa HTML của khối.
   - Máy chủ cũng từ chối mọi thay đổi xoá định dạng nếu thiếu xác nhận này (`acceptFormatChange`), kể cả khi request được gửi thẳng tới máy chủ.
3. **Thanh định dạng (TipTap: đậm, nghiêng, liên kết)** là một bước chuyển đổi bạn phải tự chọn.
   - Trước khi chuyển, editor liệt kê chính xác những gì sẽ mất. Bạn có thể Cancel, hoặc chuyển rồi Undo.
   - **HTML source** cho phép sửa trực tiếp HTML inline của khối. Phần không an toàn bị loại khi lưu.

## 3. Kiểm thử luồng dán HTML qua giao diện (Chromium)

Dữ liệu vào là **fixture nội bộ có nhãn** `fixtures/email-templates/internal-paste-workflow.html` (tổng hợp, không có nội dung khách hàng thật). Nó có:
- doctype XHTML, `<style>` với `@media`, 4 dấu comment MSO, nút VML;
- preheader ẩn;
- một đoạn có `<span>` màu đỏ, `<font>` và trường `{{ greeting_name | default: "Quý khách" }}`;
- một liên kết nằm trong đoạn văn, hai ảnh, và liên kết hủy đăng ký `{{ unsubscribe_url }}`.

HTML được dán bằng **clipboard thật** (ghi vào clipboard rồi nhấn Ctrl+V vào ô Paste HTML), không qua tải file. Spec nằm ở `tests/e2e/paste-workflow.spec.ts`.

| Bước | Kết quả | |
|---|---|---|
| Trang Emails: có ô Paste HTML và nút Import; không có nút fixture, GrapesJS hay chữ "synthetic"; ô selector và tải file ẩn trong tuỳ chọn | Đúng | **PASS** |
| Dán HTML rồi Import, không selector và không đặt tên | Tên tự lấy theo `<title>`. Bản v1 xuất ra **trùng khớp** với kết quả làm sạch của HTML đã dán | **PASS** |
| Xem trước | Tiêu đề và đoạn văn hiển thị; "All images loaded in this browser preview" | **PASS** |
| Sửa chữ 1 (tiêu đề): chọn hết, gõ "Ưu đãi tháng 11 cho ", chèn trường `greeting_name` tại con trỏ | Trạng thái `text-only` | **PASS** |
| Sửa chữ 2 (đoạn có `<span>`, `<font>` và trường trộn): thêm " Cảm ơn!" vào cuối | Trạng thái `text-only` | **PASS** |
| Sửa ảnh (bấm vào ảnh trong preview): đổi URL và alt | Đúng | **PASS** |
| Sửa liên kết nằm trong đoạn văn (bấm vào liên kết trong preview) | Đúng | **PASS** |
| Lưu | "Save as new version (4 changes)" tạo **Version 2**; ghi chú "text (all formatting kept)" | **PASS** |
| Mở lại từ danh sách "Your emails" | Mở bản mới nhất (v2) với đầy đủ chỉnh sửa. Xem với vai người nhận: "… cho Anh An", và khi thiếu tên gọi: "… cho Quý khách". v1 vẫn mở được và còn nguyên | **PASS** |
| **Xuất và so khớp từng byte** | v2 **đúng bằng v1 với đúng 4 thay đổi trên**. Mọi phần khác (style, `<span>`, `<font>`, comment MSO, VML, trường trộn, `&amp;`) **giống hệt**. Không còn `data-emt-id` hay `contenteditable`. Bản văn bản thuần có chữ mới và trường trộn | **PASS** |
| Mất định dạng → dừng lại → **Undo** | Khối trở về như cũ (`<span>` và `<font>` vẫn còn); không còn gì để lưu | **PASS** |
| Mất định dạng → **Keep** → lưu | v2 lưu khối dạng chữ thuần; ghi chú "formatting removed (accepted)"; các khối khác không đổi | **PASS** |
| **HTML source** có `<script>`, `onerror`, `javascript:` → lưu | Phần an toàn được giữ (`style`, `<strong>`); phần nguy hiểm bị loại | **PASS** |
| Thanh định dạng: liệt kê `<span>` và `<font>` sẽ mất; Cancel; rồi chuyển, gõ, **Undo** | Khối trở về nguyên bản | **PASS** |
| Dán một đoạn HTML không có `<html>`/`<body>`; gõ `<b>` dưới dạng chữ | Lưu thành `&lt;b&gt;…&lt;/b&gt;`; phần `<b style>` gốc còn nguyên | **PASS** |
| Công cụ nội bộ: thành viên (member) vào `/internal/editor-lab` bị chuyển tới trang forbidden; admin vào được; header không có liên kết `/internal` | Đúng | **PASS** |

Ảnh chụp (fixture nội bộ tổng hợp) trong `screenshots/`:
- `01-emails-page.png`
- `02-pasted.png`
- `03-text-edited-formatting-kept.png`
- `04-reopened-recipient-preview.png`
- `05-formatting-loss-choice.png`
- `06-toolbar-conversion-preview.png`

**Thử nghiệm editor cũ (fixture TỔNG HỢP A và B, chạy lại với cách sửa mới):**
- Sửa chữ trong preview cho trạng thái `text-only` ở cả A và B.
- Fixture A giữ **1/1** `<span>` có style. Lần 1 mất **1** span.
- Đủ 4 loại sửa: chữ, ảnh, nút, liên kết. Comment MSO giữ 6/6.
- Chuyển sang thanh định dạng ở fixture A báo trước: sẽ mất `<span style="color:#1f5f8b;font-weight:bold"> around "giảm 15%"`.

## 4. Kết quả kiểm thử (chu kỳ cuối, 13:21 – 13:30)

| Lệnh | Exit | Kết quả | Log |
|---|---|---|---|
| `npm run lint` | 0 | Sạch | `logs/lint.log` |
| `npm run typecheck` | 0 | Sạch | `logs/typecheck.log` |
| `npm run test:unit` | 0 | **145/145**, gồm 21 test mới trong `tests/unit/text-edits.test.ts` | `logs/unit.log` |
| `npm run test:integration` | 0 | **37/37** | `logs/integration.log` |
| `npm run test:tooling` | 0 | **7/7** (mã thoát, dọn tiến trình) | `logs/tooling.log` |
| `npm run e2e` | 0 | **33/33** (M1–M2: 15 · thử nghiệm editor: 11 · luồng dán: 7) | `logs/e2e-full-run2.log` |
| `npm run e2e -- paste-workflow editor-trial --repeat-each=2` | 0 | **36/36** (kiểm tra độ ổn định) | `logs/e2e-repeat.log` |
| `npm run smoke:local` | 0 | 6 PASS (S1, S2a–c, S3-mock, S4-m3) · 2 BLOCKED (S2-live, S3-live) · 6 NOT RUN (M4–M7) | `logs/smoke.log` |

Sau chu kỳ: **0** tiến trình node/postgres của dự án và **0** cổng dev còn mở.

**Mutation check:** khi tạm tắt hàng rào "phải xác nhận khi mất định dạng" ở máy chủ, unit test tương ứng **thất bại** (`logs/mutation-no-loss-guard.log`). Sau đó hàng rào đã được khôi phục.

### Lần thất bại đầu tiên và kiểm thử lại

| # | Lần thất bại đầu | Nguyên nhân | Sửa | Kiểm thử lại |
|---|---|---|---|---|
| F1 | Unit test mới: 6/21 fail (lần đầu, không lưu thành log; ghi lại ở đây) | **Lỗi của test:** test so với chuỗi trong fixture gốc, trong khi bộ làm sạch bỏ dấu `;` cuối `style` và viết `/>`; ngoài ra một regex khớp nhầm `onerror=` nằm trong *chữ* đã escape | Test so với đúng pipeline lưu (sửa → làm sạch lại) | 21/21 |
| F2 | `logs/e2e-paste-first-run.log`: 1/7 fail, v1 xuất ra khác dự kiến | **Lỗi của test:** route Export chuẩn hoá lại HTML (`<meta>` thay vì `<meta />`) | Giá trị kỳ vọng đi qua đúng đường Export | `logs/e2e-paste-run2.log`: 7/7 |
| F3 | `logs/e2e-full.log`: 1 fail (fixture A: không có ô chèn trường trộn, khung preview cao 150px) | **Lỗi sản phẩm:** đôi khi preview tải xong *trước khi* React hydrate xong, nên sự kiện `onLoad` bị lỡ: không chọn được vùng, không sửa được trong preview. Đã tái hiện; bản M3 lần 1 cũng có rủi ro này nhưng test cũ chỉ dùng danh sách vùng nên không thấy | Khi mount, nếu preview đã tải xong thì khởi tạo ngay, mỗi tài liệu chỉ một lần | `logs/e2e-full-run2.log` 33/33; `logs/e2e-repeat.log` 36/36 |
| F4 | Thấy trên ảnh chụp: nhãn vùng hiện `&amp;` thô | Lỗi hiển thị | Nhãn dùng chữ đã giải mã, đúng thứ tự trong tài liệu, kèm unit test | Có trong 145/145 |
| F5 | Sau khi gửi form, HTML dán vào bị chuyển sang xuống dòng CRLF | Trình duyệt luôn gửi textarea với CRLF | Bước import chuẩn hoá về LF | Bước so khớp từng byte trong e2e đạt |

## 5. Trình duyệt và trình đọc mail thật

| Loại kiểm tra | Trạng thái |
|---|---|
| Hiển thị trong **trình duyệt (Chromium, Playwright)**, 640px và 375px; so khớp HTML từng byte | **PASS** (mục 3–4) |
| **Gmail** (web, Android) | **NOT RUN.** Cần gửi thử tới hộp thư được phép, mà việc gửi chưa được phép |
| **Outlook** (desktop, web) | **NOT RUN** |
| **Ứng dụng mail di động** (Apple Mail iOS, …) | **NOT RUN** |

Kết quả trên trình duyệt **không** chứng minh Gmail, Outlook hay điện thoại hiển thị giống vậy. Những kiểm tra đó vẫn đang chờ: cần quyền gửi thử tới allowlist, hoặc dùng Litmus / Email on Acid.

## 6. Giới hạn còn lại

- **Ảnh có đường dẫn tương đối hoặc cục bộ** chỉ được cảnh báo, chưa được chuyển lên kho ảnh https (S3). Ảnh như vậy sẽ không hiện trong email thật.
- **Chữ của nút** sửa qua ô nhập ở panel bên, không sửa trong preview. Chữ trong ảnh không sửa được, vì đó là ảnh.
- **Văn bản ẩn (preheader)** chỉ sửa được bằng HTML source, vì nó không hiển thị trong preview.
- **Gõ dấu cách cuối dòng rồi chèn trường trộn**, trình duyệt có thể lưu dấu cách đó thành `&nbsp;`. Trông giống hệt, nhưng chỗ đó sẽ không ngắt dòng. Trong lần chạy cuối: 0 trường hợp.
- **Thanh định dạng (TipTap)** vẫn không giữ được màu, font và cỡ chữ. Vì thế nó là lựa chọn bạn phải tự bật, có xem trước phần sẽ mất và có Undo; nó không phải cách sửa mặc định.
- **Khối có markup mà trình duyệt phân tích khác máy chủ** (HTML không hợp lệ) không sửa được trong preview; editor tự chuyển sang HTML source.
- **Bản sao file bạn đã gửi** từ lần 1 vẫn nằm trong `.local/real-templates/` (Git bỏ qua, chưa bao giờ được commit). Từ rev 2 không còn test nào tự đọc file này; bạn có thể xoá nó.

## 7. Checkpoint Git cục bộ

Commit trên nhánh `m3-editor-trial`, tag **`m3-rev2-checkpoint`**. Tag `m3-checkpoint` (`10ac055`) được giữ nguyên. Không có remote, không push.
