ALTER TABLE "agent_mission_nodes"
  ADD COLUMN "executor" TEXT,
  ADD COLUMN "agent_profile_id" TEXT,
  ADD COLUMN "profile_version" TEXT,
  ADD COLUMN "workspace_policy" TEXT,
  ADD COLUMN "concurrency_group" TEXT,
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "join_policy" JSONB,
  ADD COLUMN "failure_policy" JSONB,
  ADD COLUMN "ready_at" TIMESTAMP(3),
  ADD COLUMN "available_at" TIMESTAMP(3),
  ADD COLUMN "result_artifact_id" UUID,
  ADD COLUMN "error_code" TEXT,
  ADD COLUMN "error_message" TEXT;

CREATE INDEX "agent_mission_nodes_status_available_at_priority_idx"
  ON "agent_mission_nodes"("status", "available_at", "priority");
CREATE INDEX "agent_mission_nodes_mission_id_concurrency_group_status_idx"
  ON "agent_mission_nodes"("mission_id", "concurrency_group", "status");

CREATE TABLE "agent_mission_node_attempts" (
  "id" UUID NOT NULL,
  "mission_id" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "agent_run_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "last_heartbeat_at" TIMESTAMP(3),
  "fencing_token" INTEGER NOT NULL DEFAULT 0,
  "input_manifest_hash" TEXT NOT NULL,
  "result_artifact_id" UUID,
  "error_code" TEXT,
  "error_message" TEXT,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_mission_node_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_mission_node_attempts_agent_run_id_key"
  ON "agent_mission_node_attempts"("agent_run_id");
CREATE UNIQUE INDEX "agent_mission_node_attempts_node_id_attempt_key"
  ON "agent_mission_node_attempts"("node_id", "attempt");
CREATE INDEX "agent_mission_node_attempts_mission_id_status_idx"
  ON "agent_mission_node_attempts"("mission_id", "status");
CREATE INDEX "agent_mission_node_attempts_status_lease_expires_at_idx"
  ON "agent_mission_node_attempts"("status", "lease_expires_at");

CREATE TABLE "agent_node_artifacts" (
  "id" UUID NOT NULL,
  "mission_id" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "attempt_id" UUID NOT NULL,
  "artifact_type" TEXT NOT NULL,
  "schema_id" TEXT NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "storage_path" TEXT NOT NULL,
  "content_sha256" TEXT NOT NULL,
  "byte_length" INTEGER NOT NULL,
  "source_run_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'accepted',
  "manifest" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_node_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_node_artifacts_attempt_id_artifact_type_key"
  ON "agent_node_artifacts"("attempt_id", "artifact_type");
CREATE INDEX "agent_node_artifacts_mission_id_node_id_idx"
  ON "agent_node_artifacts"("mission_id", "node_id");
CREATE INDEX "agent_node_artifacts_content_sha256_idx"
  ON "agent_node_artifacts"("content_sha256");

CREATE TABLE "agent_node_jobs" (
  "id" UUID NOT NULL,
  "mission_id" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "attempt_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "last_heartbeat_at" TIMESTAMP(3),
  "fencing_token" INTEGER NOT NULL DEFAULT 0,
  "envelope" JSONB NOT NULL,
  "event_sequence" INTEGER NOT NULL DEFAULT 0,
  "error_code" TEXT,
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_node_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_node_jobs_attempt_id_key" ON "agent_node_jobs"("attempt_id");
CREATE INDEX "agent_node_jobs_status_available_at_priority_idx"
  ON "agent_node_jobs"("status", "available_at", "priority");
CREATE INDEX "agent_node_jobs_status_lease_expires_at_idx"
  ON "agent_node_jobs"("status", "lease_expires_at");
CREATE INDEX "agent_node_jobs_mission_id_status_idx"
  ON "agent_node_jobs"("mission_id", "status");

CREATE TABLE "agent_node_outbox_events" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "mission_id" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_node_outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_node_outbox_events_job_id_sequence_key"
  ON "agent_node_outbox_events"("job_id", "sequence");
CREATE INDEX "agent_node_outbox_events_mission_id_created_at_idx"
  ON "agent_node_outbox_events"("mission_id", "created_at");
CREATE INDEX "agent_node_outbox_events_published_at_created_at_idx"
  ON "agent_node_outbox_events"("published_at", "created_at");

ALTER TABLE "agent_mission_node_attempts"
  ADD CONSTRAINT "agent_mission_node_attempts_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "agent_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_mission_node_attempts_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "agent_mission_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_mission_node_attempts_agent_run_id_fkey"
  FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_node_artifacts"
  ADD CONSTRAINT "agent_node_artifacts_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "agent_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_node_artifacts_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "agent_mission_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_node_artifacts_attempt_id_fkey"
  FOREIGN KEY ("attempt_id") REFERENCES "agent_mission_node_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_node_jobs"
  ADD CONSTRAINT "agent_node_jobs_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "agent_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_node_jobs_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "agent_mission_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_node_jobs_attempt_id_fkey"
  FOREIGN KEY ("attempt_id") REFERENCES "agent_mission_node_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_node_outbox_events"
  ADD CONSTRAINT "agent_node_outbox_events_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "agent_node_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
