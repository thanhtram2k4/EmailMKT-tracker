/**
 * SYNTHETIC CONTACTS: fabricated test data, not real people.
 *
 * - Every address uses a domain reserved for documentation/testing (RFC 2606 / RFC 6761):
 *   example.com, example.org, example.net, or the reserved ".example" top-level domain.
 * - Names are common Vietnamese given/family-name combinations chosen for diacritic coverage;
 *   they do not refer to real individuals.
 * - Every contact carries the tag "Dữ liệu mẫu" (sample data).
 *
 * Coverage: Vietnamese diacritics (incl. decomposed NFD input), missing greeting names, duplicate
 * emails (2-way and 3-way, differing in case/whitespace), invalid/missing addresses, every
 * subscription state, consent-evidence references, a trashed page and a page with no name.
 */
import type { SimpleContact } from "./fake-notion";

export type SyntheticContact = SimpleContact & { key: string; inTrash?: boolean; note: string };

const SAMPLE = "Dữ liệu mẫu";

export const SYNTHETIC_CONTACTS: SyntheticContact[] = [
  // --- regular contacts with diacritics and greeting names
  { key: "an", name: "Nguyễn Văn An", greeting: "Anh An", email: "an.nguyen@congty-anphat.example", company: "Công ty An Phát", tags: [SAMPLE, "Khách hàng", "VIP"], subscription: "Subscribed", consentEvidence: "Form đăng ký 2026-03-02 #F-1021", note: "regular, has consent evidence ref" },
  { key: "ngoc", name: "Trần Thị Bích Ngọc", greeting: "Chị Ngọc", email: "ngoc.tran@example.com", company: "Minh Khoa Group", tags: [SAMPLE, "Khách hàng"], subscription: "Subscribed", note: "regular" },
  { key: "ha-nfd", name: "Phạm Thị Thu Hà".normalize("NFD"), greeting: "Chị Hà".normalize("NFD"), email: "ha.pham@example.net", company: "Hà Phạm Studio", tags: [SAMPLE, "Đối tác"], note: "name supplied in decomposed (NFD) Unicode" },
  { key: "bao", name: "Đặng Quốc Bảo", greeting: "Anh Bảo", email: "Bao.Dang@Example.org", company: "Bảo Long Logistics", tags: [SAMPLE, "Khách hàng"], note: "mixed-case email" },
  { key: "lan", name: "Đinh Thị Lan", greeting: "Cô Lan", email: "lan.dinh@example.com", company: "Trường Mầm non Hoa Sen", tags: [SAMPLE, "Giáo dục"], subscription: "Subscribed", consentEvidence: "https://forms.example.com/r/abc123", note: "evidence URL" },
  { key: "minh", name: "Lương Đức Minh", greeting: "Thầy Minh", email: "minh.luong@example.org", tags: [SAMPLE, "Giáo dục"], note: "no company" },
  { key: "vy", name: "Tạ Ngọc Tường Vy", greeting: "Bạn Vy", email: "vy.ta@example.net", company: "Vy Design", tags: [SAMPLE, "  Khách hàng  ", "Khách hàng"], note: "tag duplicates/whitespace" },
  { key: "quan", name: "Châu Minh Quân", greeting: "Anh Quân", email: "quan.chau@congty-anphat.example", company: "Công ty An Phát", tags: [SAMPLE, "Đối tác"], note: "regular" },
  { key: "uyen", name: "Kiều Phương Uyên", greeting: "Chị Uyên", email: "uyen.kieu@example.com", company: "Uyên Spa", tags: [SAMPLE], subscription: "Subscribed", note: "regular" },
  { key: "khoa", name: "Mạc Đăng Khoa", greeting: "Anh Khoa", email: "khoa.mac@example.org", company: "Khoa Tech", tags: [SAMPLE, "Công nghệ"], note: "regular" },
  { key: "thao", name: "Âu Dương Thảo", greeting: "Chị Thảo", email: "thao.au@example.net", tags: [SAMPLE], note: "regular" },
  { key: "nhan", name: "Ông Thiện Nhân", greeting: "Anh Nhân", email: "nhan.ong@example.com", company: "Nhân Hòa Trading", tags: [SAMPLE, "Khách hàng"], note: "regular" },
  { key: "yen", name: "Quách Hải Yến", greeting: "Chị Yến", email: "yen.quach@example.org", tags: [SAMPLE, "VIP"], consentEvidence: "Hợp đồng HĐ-2025-118, điều 7", note: "contract evidence ref" },
  { key: "dung", name: "Lâm Tiến Dũng", greeting: "Anh Dũng", email: "dung.lam@example.net", company: "Dũng Lâm Co.", tags: [SAMPLE], note: "regular" },
  { key: "hoa", name: "Giang Thị Hoa", greeting: "Cô Hoa", email: "hoa.giang@example.com", tags: [SAMPLE, "Giáo dục"], note: "regular" },
  { key: "tien", name: "Thái Bảo Tiên", greeting: "Bạn Tiên", email: "tien.thai@example.org", company: "Tiên Cosmetics", tags: [SAMPLE], subscription: "Subscribed", note: "regular" },

  // --- missing greeting names (fallback needed in M4)
  { key: "phuc", name: "Lê Hoàng Phúc", greeting: null, email: "phuc.le@example.org", company: "Phúc Lợi JSC", tags: [SAMPLE, "Đối tác"], note: "missing greeting name" },
  { key: "thu", name: "Võ Minh Thư", greeting: "   ", email: "thu.vo@example.net", tags: [SAMPLE], note: "greeting is whitespace only" },
  { key: "hieu", name: "Cao Trung Hiếu", greeting: null, email: "hieu.cao@example.com", company: "Hiếu Cao Media", tags: [SAMPLE], note: "missing greeting name" },

  // --- subscription states set in Notion
  { key: "huy", name: "Bùi Đức Huy", greeting: "Anh Huy", email: "huy.bui@example.com", company: "Huy Bùi Consulting", tags: [SAMPLE], subscription: "Unsubscribed", note: "unsubscribed in Notion → suppression" },
  { key: "tram", name: "Hồ Ngọc Trâm", greeting: "Chị Trâm", email: "tram.ho@example.org", tags: [SAMPLE], subscription: "Bounced", note: "bounced in Notion → suppression" },
  { key: "tung", name: "Dương Thanh Tùng", greeting: "Anh Tùng", email: "tung.duong@example.net", tags: [SAMPLE], subscription: "Complained", note: "complained in Notion → suppression" },
  { key: "linh", name: "Phan Khánh Linh", greeting: "Chị Linh", email: "linh.phan@example.com", tags: [SAMPLE], subscription: "Unsubscribed", consentEvidence: "Form đăng ký 2025-11-20 #F-0877", note: "evidence ref but unsubscribed: withdrawal wins" },

  // --- duplicates
  { key: "mai-1", name: "Ngô Thị Mai", greeting: "Chị Mai", email: "mai.ngo@example.com", company: "Mai Ngô Bakery", tags: [SAMPLE], note: "duplicate group A (1/2)" },
  { key: "mai-2", name: "Ngô Thị Mai (bản sao)", greeting: "Mai", email: "  Mai.Ngo@Example.com ", tags: [SAMPLE], note: "duplicate group A (2/2): case + whitespace" },
  { key: "khang-1", name: "Huỳnh Gia Khang", greeting: "Anh Khang", email: "khang.huynh@example.org", company: "Gia Khang Foods", tags: [SAMPLE], note: "duplicate group B (1/3)" },
  { key: "khang-2", name: "Huỳnh Khang", greeting: "Khang", email: "KHANG.HUYNH@example.org", tags: [SAMPLE], note: "duplicate group B (2/3)" },
  { key: "khang-3", name: "K. Huỳnh", greeting: null, email: "khang.huynh@example.org", tags: [SAMPLE], note: "duplicate group B (3/3), missing greeting" },

  // --- invalid or missing addresses
  { key: "trang", name: "Lý Thu Trang", greeting: "Chị Trang", email: "trang.ly@@example.com", tags: [SAMPLE], note: "invalid: two @" },
  { key: "tuan", name: "Mai Anh Tuấn", greeting: "Anh Tuấn", email: "tuan.mai example.com", tags: [SAMPLE], note: "invalid: whitespace, no @" },
  { key: "son", name: "Trịnh Văn Sơn", greeting: "Anh Sơn", email: "sơn.trinh@example.com", tags: [SAMPLE], note: "invalid: non-ASCII local part" },
  { key: "nga", name: "Đoàn Thúy Nga", greeting: "Chị Nga", email: null, tags: [SAMPLE], note: "missing email" },
  { key: "dinh", name: "Đinh Công Lâm", greeting: "Anh Lâm", email: "lam..dinh@example.com", tags: [SAMPLE], note: "invalid: consecutive dots" },
  { key: "hung", name: "Vũ Mạnh Hùng", greeting: "Anh Hùng", email: "hung.vu@localhost", tags: [SAMPLE], note: "invalid: domain without dot" },

  // --- other edge cases
  { key: "noname", name: null, greeting: null, email: "no-name@example.net", tags: [SAMPLE], note: "missing full name" },
  { key: "trashed", name: "Liên hệ đã xóa", greeting: "Anh Xóa", email: "deleted.contact@example.com", tags: [SAMPLE], inTrash: true, note: "page in Notion trash" },
  { key: "long", name: "Tôn Nữ Hoàng Diễm Phương Thảo", greeting: "Chị Phương Thảo", email: "phuongthao.ton@example.org", company: "Công ty TNHH Thương mại Dịch vụ Phương Thảo", tags: [SAMPLE, "Khách hàng", "VIP", "Đối tác"], note: "long name and company" },
  { key: "upper", name: "NGUYỄN THỊ HẠNH", greeting: "Chị Hạnh", email: "HANH.NGUYEN@EXAMPLE.NET", tags: [SAMPLE], note: "all-caps name and email" },
  { key: "plus", name: "Hà Văn Tài", greeting: "Anh Tài", email: "tai.ha+news@example.com", tags: [SAMPLE], note: "plus-address (not folded)" },
  { key: "dots", name: "Lò Văn Pao", greeting: "Anh Pao", email: "pao.lo@sub.congty-anphat.example", tags: [SAMPLE], note: "sub-domain" },
];
