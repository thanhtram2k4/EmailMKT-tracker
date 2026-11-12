-- Template versions are immutable history: a save is always a new row.
CREATE TRIGGER template_versions_no_update_delete
  BEFORE UPDATE OR DELETE ON "template_versions"
  FOR EACH ROW EXECUTE FUNCTION crm_prevent_change();
