-- A documents row now exists before its file does. 'uploading' marks a row
-- whose file hasn't been confirmed yet.
--
-- Own migration on purpose: Postgres refuses to use a new enum value inside
-- the transaction that added it, and the next migration uses it in a
-- default, a check constraint, a policy and two functions.
alter type public.document_status add value if not exists 'uploading' before 'pending';
