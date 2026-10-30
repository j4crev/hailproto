-- NULL distinguishes accounts that have not imported browser preferences yet.
ALTER TABLE account_message_preferences
  ADD COLUMN theme text CHECK (theme IN ('system', 'light', 'dark')),
  ADD COLUMN show_header_images boolean;
