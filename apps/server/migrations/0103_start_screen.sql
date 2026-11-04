ALTER TABLE account_message_preferences
  ADD COLUMN start_screen text NOT NULL DEFAULT 'feed' CHECK (start_screen IN ('feed', 'inbox'));
