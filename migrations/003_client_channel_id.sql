-- client_channel_snapshots stores live viewer / like counts for the channel
-- pinned by CLIENT_CHANNEL_ID. Until now the rows had no channel_id, so when
-- the operator swapped CLIENT_CHANNEL_ID via the settings UI the dashboard
-- kept showing the previous channel's data (most recent row wins, regardless
-- of which channel produced it).
--
-- Adding channel_id lets every read filter to the currently configured
-- channel; rows belonging to a previously configured channel are simply
-- ignored rather than mixed in.
ALTER TABLE client_channel_snapshots ADD COLUMN channel_id TEXT;

CREATE INDEX IF NOT EXISTS idx_client_channel_snapshots_channel_id_polled_at
  ON client_channel_snapshots (channel_id, polled_at);
