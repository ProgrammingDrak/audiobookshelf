-- Operator-reviewed migration, never executed automatically by app startup.
-- Run with a migration role against the explicitly approved database only.
BEGIN;
CREATE SCHEMA quietshelf;
REVOKE ALL ON SCHEMA quietshelf FROM PUBLIC;
CREATE TABLE quietshelf.books (
  owner text NOT NULL, id text NOT NULL, book_key text NOT NULL, body jsonb NOT NULL,
  revision integer NOT NULL CHECK (revision > 0), deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner,id)
);
CREATE UNIQUE INDEX quietshelf_live_book ON quietshelf.books(owner,book_key) WHERE NOT deleted;
CREATE TABLE quietshelf.receipts(owner text NOT NULL,op text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(owner,op));
REVOKE ALL ON ALL TABLES IN SCHEMA quietshelf FROM PUBLIC;
-- RLS denies direct Data API access unless policies are explicitly added.
ALTER TABLE quietshelf.books ENABLE ROW LEVEL SECURITY;
ALTER TABLE quietshelf.receipts ENABLE ROW LEVEL SECURITY;
COMMIT;
-- The runtime adapter is server-only. Provision a restricted backend role and
-- reviewed RLS policy separately. Do not expose this schema in Supabase Data API.
-- This file creates no credentials, roles, permissive policies or grants.
