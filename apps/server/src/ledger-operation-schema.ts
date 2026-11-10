/** Display grouping is separate from immutable ledger entries and journal receipts. */
export const ledgerOperationSchema = `
CREATE TABLE IF NOT EXISTS ledger_operations (
  "entryId" TEXT PRIMARY KEY REFERENCES ledger(id) ON DELETE CASCADE,
  "operationId" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_operations_operation ON ledger_operations("operationId","entryId");
`;
