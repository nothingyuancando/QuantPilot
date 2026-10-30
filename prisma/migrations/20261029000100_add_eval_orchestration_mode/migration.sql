ALTER TABLE "eval_queue_items"
  ADD COLUMN "orchestration_mode" TEXT NOT NULL DEFAULT 'single_agent';

CREATE INDEX "eval_queue_items_orchestration_mode_created_at_idx"
  ON "eval_queue_items"("orchestration_mode", "created_at");
