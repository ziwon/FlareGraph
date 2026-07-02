-- Idempotent vector bookkeeping: one live ref per (target, model). Queue
-- retries re-run embedChunks; the unique index turns duplicate inserts into
-- upserts instead of accumulating rows.
DELETE FROM vector_refs
WHERE id NOT IN (
  SELECT MIN(id) FROM vector_refs GROUP BY target_type, target_id, model
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vector_refs_unique
  ON vector_refs(target_type, target_id, model);
