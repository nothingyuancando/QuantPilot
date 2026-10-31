-- NULL scope quarantines historical/unattributed rows. Never guess their owner.
ALTER TABLE "research_watchlists" ADD COLUMN "project_id" TEXT, ADD COLUMN "created_by_id" TEXT;
ALTER TABLE "research_report_runs" ADD COLUMN "project_id" TEXT, ADD COLUMN "created_by_id" TEXT;
ALTER TABLE "research_reports" ADD COLUMN "project_id" TEXT, ADD COLUMN "created_by_id" TEXT;
ALTER TABLE "notification_channels" ADD COLUMN "project_id" TEXT, ADD COLUMN "created_by_id" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "project_id" TEXT, ADD COLUMN "created_by_id" TEXT;

ALTER TABLE "research_watchlists" ADD CONSTRAINT "research_watchlists_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "research_report_runs" ADD CONSTRAINT "research_report_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "research_watchlists_project_id_updated_at_idx" ON "research_watchlists"("project_id", "updated_at");
CREATE INDEX "research_report_runs_project_id_started_at_idx" ON "research_report_runs"("project_id", "started_at");
CREATE INDEX "research_reports_project_id_created_at_idx" ON "research_reports"("project_id", "created_at");
CREATE INDEX "notification_channels_project_id_updated_at_idx" ON "notification_channels"("project_id", "updated_at");
CREATE INDEX "notification_deliveries_project_id_created_at_idx" ON "notification_deliveries"("project_id", "created_at");
