-- A Match without scores was stored as JSON null (jsonb 'null', not SQL null). recent_wins and account_history flip the pair for the
-- winner with jsonb_build_array(scores->1, scores->0), which turned it into [null, null] and showed "null–null". Store SQL null instead.
update public.match_history set scores = null where scores = 'null'::jsonb;
