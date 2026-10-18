BEGIN;

-- Agent-side "其他消息" carries no content in the API (cards, images or robot messages) and most arrive within
-- seconds of the buyer. Turns are kept for both readings so the setting can switch without re-syncing:
-- strict = only text replies answer a buyer; loose = "其他消息" also answers.
ALTER TABLE perf_chat_turns ADD COLUMN mode text NOT NULL DEFAULT 'loose' CHECK (mode IN ('strict','loose'));
ALTER TABLE perf_chat_turns ALTER COLUMN mode DROP DEFAULT;
ALTER TABLE perf_chat_turns DROP CONSTRAINT perf_chat_turns_session_id_turn_index_key;
ALTER TABLE perf_chat_turns ADD CONSTRAINT perf_chat_turns_session_mode_index_key UNIQUE (session_id, mode, turn_index);

ALTER TABLE perf_chat_sessions
  ADD COLUMN other_agent_messages integer NOT NULL DEFAULT 0,
  -- Sessions built by an older turn algorithm are rebuilt from stored messages, without platform calls.
  ADD COLUMN turns_version integer NOT NULL DEFAULT 1;

ALTER TABLE perf_settings ADD COLUMN count_other_as_reply boolean NOT NULL DEFAULT false;

COMMIT;
