-- SECTOR-8 data reset
-- Deletes all player-owned data while preserving tables, indexes, RLS, and functions.
-- Run this entire file in the Supabase SQL Editor.

begin;

truncate table
  public.auth_sessions,
  public.friend_requests,
  public.friends,
  public.match_history,
  public.players
restart identity;

commit;

-- Expected result after the transaction: all counts are 0.
select
  (select count(*) from public.players) as players,
  (select count(*) from public.auth_sessions) as auth_sessions,
  (select count(*) from public.friend_requests) as friend_requests,
  (select count(*) from public.friends) as friends,
  (select count(*) from public.match_history) as match_history;
