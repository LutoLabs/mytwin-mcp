-- 031-referral-attribution.sql
-- Phase 3 (the viral signal): attribute a new signup back to the user whose
-- shared artifact brought them in.
--
-- A public storefront link (/p/<slug>) sends viewers to /twin?ref=<slug>. The
-- ref rides through the existing magic-link flow (exactly like invite_code and
-- claim_tenant_id already do) and, at account creation, we resolve the slug to
-- the sharing owner and stamp it on the new user row. This makes "did a real
-- user share something that brought in a new signup" a single queryable fact.
--
-- ADDITIVE ONLY: two nullable columns on users, one nullable column on
-- magic_tokens. No data touched. Safe to re-run.

begin;

-- Who referred this account (the owner of the shared artifact), and the raw
-- source token (the public-link slug) for analytics. on delete set null so
-- deleting the referrer never blocks deleting the referred account.
alter table users add column if not exists referred_by_user_id uuid references users(id) on delete set null;
alter table users add column if not exists referred_via text;

create index if not exists users_referred_by_idx on users(referred_by_user_id) where referred_by_user_id is not null;

-- Carry the referrer slug from the claim request through to verify, the same way
-- invite_code (006) and claim_tenant_id (012) already ride the token.
alter table magic_tokens add column if not exists referrer text;

commit;

notify pgrst, 'reload schema';
