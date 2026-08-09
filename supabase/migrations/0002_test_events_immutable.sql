-- Make test_events genuinely immutable.
--
-- 0001 revoked UPDATE but left DELETE and TRUNCATE, which still allowed clients
-- to destroy raw events — breaking the append-only invariant in
-- docs/ARCHITECTURE.md §2, on which all recomputation depends.
--
-- Deleting a test still removes its events: ON DELETE CASCADE runs as the
-- constraint owner during the referential action, so it is unaffected by the
-- client's own grants. Discarding a bad test therefore still works, while
-- direct tampering with the archive does not.

revoke delete, truncate on public.test_events from authenticated;
revoke delete, truncate on public.test_events from anon;
