/** Current database contract. Application startup never runs data conversions. */
export const DATABASE_MIGRATIONS = [
  'native-message-schema',
  'committed-change-predecessors',
  'retire-converted-topic-containers',
  'explicit-personal-annotation-reasons',
  'canonical-query-records',
  'explicit-access-policy',
  'complete-historical-message-formats',
  'restore-historical-settlement-targets',
  'correct-historical-value-vote-messages',
  'normalize-historical-annotation-stances',
] as const;
