/**
 * M3 trial probe: prints COUNTS ONLY (no template content) for each input, so it is safe to run
 * on the real template too.  Usage: npx tsx scripts/editor-trial/probe.ts
 */
import fs from "node:fs";
import { countConditionalComments, normalizeForCompare } from "../../src/lib/templates/html-doc";
import { regionsOf, applyEdits } from "../../src/lib/templates/editable";
import { lintTemplate } from "../../src/lib/templates/lint";
import { extractFragment, sanitizeEmailHtml } from "../../src/lib/templates/sanitize";
import { scanMergeFields } from "../../src/lib/templates/merge";

const inputs = [
  { name: "synthetic-a", path: "fixtures/email-templates/synthetic-a-newsletter.html" },
  { name: "synthetic-b", path: "fixtures/email-templates/synthetic-b-promo-hazards.html" },
  { name: "real-1 (whole page)", path: ".local/real-templates/real-1-wildcats-email-gmail.html" },
  { name: "real-1 (#email)", path: ".local/real-templates/real-1-wildcats-email-gmail.html", extract: "#email" },
];

for (const i of inputs) {
  if (!fs.existsSync(i.path)) {
    console.log(`${i.name}: NOT FOUND`);
    continue;
  }
  let raw = fs.readFileSync(i.path, "utf8");
  if (i.extract) {
    const x = extractFragment(raw, i.extract);
    raw = x.html;
    console.log(`${i.name}: extract ${i.extract} found=${x.found}`);
  }
  const { html, report } = sanitizeEmailHtml(raw);
  const regions = regionsOf(html);
  const kinds = regions.reduce<Record<string, number>>((a, r) => ((a[r.kind] = (a[r.kind] ?? 0) + 1), a), {});
  const noEdit = applyEdits(html, []).html;
  const identical = noEdit === html;
  const normIdentical = normalizeForCompare(noEdit) === normalizeForCompare(html);
  const lint = lintTemplate(html);
  const merge = scanMergeFields(html);
  console.log(
    JSON.stringify(
      {
        input: i.name,
        bytesIn: Buffer.byteLength(raw),
        bytesOut: Buffer.byteLength(html),
        sanitize: report,
        msoMarkersIn: countConditionalComments(raw),
        msoMarkersOut: countConditionalComments(html),
        regions: kinds,
        regionsWithUnsupportedInline: regions.filter((r) => r.unsupportedInline?.length).length,
        noEditRoundTripIdentical: identical,
        noEditRoundTripNormalizedIdentical: normIdentical,
        mergeUses: merge.uses.length,
        mergeProblems: merge.uses.filter((u) => u.problem).map((u) => u.problem),
        liquidTags: merge.liquidTags.length,
        lintCounts: lint.findings.reduce<Record<string, number>>((a, f) => ((a[`${f.severity}:${f.area}`] = (a[`${f.severity}:${f.area}`] ?? 0) + 1), a), {}),
      },
      null,
      0,
    ),
  );
}
