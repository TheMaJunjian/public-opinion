import { DISPLAY_DEPENDENCY_ROLES } from '@gonglun/core';

const roles = `'${JSON.stringify(DISPLAY_DEPENDENCY_ROLES)}'::jsonb`;
/** Same primary-relation and attachment policy as messageDisplayDependency. */
function primary(alias: string) {
  return `(SELECT part.value FROM jsonb_array_elements(${alias}.body::jsonb->'parts') WITH ORDINALITY part(value,position)
    WHERE part.value->>'type'='relation'
      AND (part.value->>'relation'<>'member-of' OR jsonb_array_length(COALESCE(part.value #> '{roles,member}','[]'::jsonb))>0)
      AND NOT ((part.value->>'id'='self-stance' OR part.value->>'id' LIKE 'minimum-self-stance-%')
        AND part.value->>'relation' IN ('agree','disagree')
        AND jsonb_array_length(COALESCE(part.value #> '{roles,target}','[]'::jsonb))=1
        AND part.value #>> '{roles,target,0,reference,messageId}'=${alias}.id)
    ORDER BY part.position LIMIT 1)`;
}
export function displayAttachmentSql(alias: string, host: string) {
  return `(EXISTS(SELECT 1 FROM ${primary(alias)} AS semantic,
      jsonb_array_elements(semantic.value->'roles'->(${roles}->>(semantic.value->>'relation'))) binding
      WHERE binding.value #>> '{reference,messageId}'=${host})
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(${alias}.body::jsonb->'parts') part
      WHERE part->>'type'='display' AND part #>> '{target,messageId}'=${host}))`;
}

export function isDependentMessageSql(alias: string) {
  return `(EXISTS(SELECT 1 FROM ${primary(alias)} semantic WHERE ${roles} ? (semantic.value->>'relation'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(${alias}.body::jsonb->'parts') part
      WHERE part->>'type'='display' AND part #>> '{target,messageId}' IS NOT NULL))`;
}
