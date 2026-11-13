import type { Audience } from "../../lib/campaigns/audience";

/** Audience choice: all eligible contacts, or contacts with any of the ticked tags. Plain form controls (no JS needed). */
export function AudienceFields({ tags, value }: { tags: string[]; value?: Audience }) {
  const kind = value?.kind ?? "all_eligible";
  const chosen = value?.kind === "tags" ? value.tags : [];
  return (
    <fieldset className="stack" data-testid="audience-fields">
      <legend>Audience</legend>
      <label className="check">
        <input type="radio" name="audienceKind" value="all_eligible" defaultChecked={kind === "all_eligible"} data-testid="audience-all" /> All eligible contacts
      </label>
      <label className="check">
        <input type="radio" name="audienceKind" value="tags" defaultChecked={kind === "tags"} data-testid="audience-tags" /> Contacts with any of these tags:
      </label>
      {tags.length ? (
        <div className="row small" role="group" aria-label="Tags">
          {tags.map((t) => (
            <label key={t} className="pill check">
              <input type="checkbox" name="tags" value={t} defaultChecked={chosen.includes(t)} /> {t}
            </label>
          ))}
        </div>
      ) : (
        <p className="muted small m0">No tags in the CRM yet.</p>
      )}
      <p className="muted small m0">Archived, invalid, duplicate (unresolved), suppressed and no-consent contacts are always excluded; the review shows how many.</p>
    </fieldset>
  );
}
