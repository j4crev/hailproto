-- Roll back application consumers first. Export display preferences before dropping
-- these columns if they must be restored; Trash preferences are preserved.
ALTER TABLE account_message_preferences DROP COLUMN theme, DROP COLUMN show_header_images;
