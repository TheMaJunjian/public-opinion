import type { Store } from '../../server/src/db.js';
import { ledgerOperationSchema } from '../../server/src/ledger-operation-schema.js';

/** Recover exact operation boundaries from receipts; never infer them from timestamps. */
export async function migrateLedgerOperations(store: Store) {
  await store.db.exec(ledgerOperationSchema);
  await store.db.exec(`WITH batches AS (
    SELECT 'batch:'||md5(jsonb_build_array("userId","requestId")::text) AS operation,
      "userId",input::jsonb AS input,result::jsonb AS result FROM command_requests
  ), batch_changes AS (
    SELECT b.operation,c.body::jsonb AS body FROM batches b JOIN changes c
      ON c.sequence>(b.result #>> '{projection,after}')::bigint AND c.sequence<=(b.result->>'sequence')::bigint
    UNION ALL
    SELECT b.operation,r.result::jsonb->'change' FROM batches b
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.input->'commands','[]'::jsonb)) command
      JOIN requests r ON r."userId"=b."userId" AND r."requestId"=command->>'id'
  ) INSERT INTO ledger_operations("entryId","operationId")
    SELECT l.id,c.operation FROM batch_changes c
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.body->'ledger','[]'::jsonb)) entry
      JOIN ledger l ON l.id=entry->>'id'
    ORDER BY (c.body->>'sequence')::bigint,c.operation
    ON CONFLICT("entryId") DO NOTHING;
  WITH sources AS (
    SELECT 'request:'||md5(jsonb_build_array("userId","requestId")::text) AS operation,
      result::jsonb->'change' AS body FROM requests
  ) INSERT INTO ledger_operations("entryId","operationId")
    SELECT l.id,s.operation FROM sources s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.body->'ledger','[]'::jsonb)) entry
      JOIN ledger l ON l.id=entry->>'id'
    ON CONFLICT("entryId") DO NOTHING;
  INSERT INTO ledger_operations("entryId","operationId")
    SELECT l.id,'change:'||c.sequence FROM changes c
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.body::jsonb->'ledger','[]'::jsonb)) entry
      JOIN ledger l ON l.id=entry->>'id'
    ON CONFLICT("entryId") DO NOTHING;`);
}
