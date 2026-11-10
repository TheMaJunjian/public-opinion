/** Notification sections are presentation filters; historical delivery categories stay unchanged. */
export const notificationSectionSql = (alias = 'n') => `(CASE WHEN ${alias}.category='review'
  AND (${alias}.kind='review-revoked' OR (${alias}.kind='review-assigned' AND review_task.status IN ('revoked','expired','closed')))
  THEN 'review-revoked' ELSE ${alias}.category END)`;

/** The notice identifies an immutable assignment round, while handling state comes from that task. */
export const reviewTaskJoinsSql = (at: string) => `LEFT JOIN LATERAL (
  SELECT CASE
    WHEN a."submittedAt" IS NOT NULL OR EXISTS(SELECT 1 FROM moderation_votes v WHERE v."caseId"=a."caseId" AND v.round=a.round AND v."userId"=a."userId") THEN 'submitted'
    WHEN a."revokedAt" IS NOT NULL THEN 'revoked'
    WHEN a."expiresAt"<=${at} THEN 'expired'
    WHEN a."caseId" IS NULL OR a.round<>c.round
      OR NOT COALESCE(CASE WHEN c.settlement IS NULL OR c.settlement='null'::jsonb THEN c.status IN ('pending','appeal')
        ELSE c.settlement->>'finalized'='false' AND c."releaseAt">${at} END,FALSE)
      OR EXISTS(SELECT 1 FROM disabled_accounts d WHERE d."userId"=n."userId")
      OR EXISTS(SELECT 1 FROM moderation_candidate_preferences p WHERE p."userId"=n."userId" AND NOT p.enabled) THEN 'closed'
    ELSE 'pending' END AS status,a."expiresAt"
  FROM moderation_cases c
  LEFT JOIN revisions event ON NOT (n.body ? 'reviewRound') AND event."messageId"=n."sourceId" AND event.revision=(n.body->>'sourceRevision')::integer
  LEFT JOIN moderation_assignments a ON a."caseId"=c.id AND a."userId"=n."userId"
    AND a.round=COALESCE((n.body->>'reviewRound')::integer,
      (jsonb_path_query_first(event.body::jsonb,'$.parts[*] ? (@.type == "data").value.reviewRound') #>> '{}')::integer)
  WHERE n.category='review' AND n.kind='review-assigned' AND c."messageId"=n."targetId" AND c.revision=(n.body#>>'{reviewTarget,revision}')::integer
) review_task ON TRUE`;
