\set ON_ERROR_STOP on
SET TIME ZONE 'UTC';
SET extra_float_digits = 3;
-- Hash every public table, including Prisma migrations, without exporting secrets.
-- Run after stopping all writers. May be slow on large databases.
SELECT format(
  'SELECT json_build_object(''table'', %L, ''rows'', count(*), ''fingerprint'', md5(coalesce(string_agg(row_hash, '''' ORDER BY row_hash), ''''))) FROM (SELECT md5(row_to_json(t)::text) AS row_hash FROM %I.%I t) hashes;',
  tablename, schemaname, tablename
) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
\gexec
