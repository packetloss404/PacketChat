-- Removes the break-glass emergency-admin feature.
--
-- Any existing break-glass accounts are demoted to ordinary admins rather than
-- deleted, so an operator does not silently lose the only account they can
-- still reach. Drop them manually afterwards if they are not wanted.

alter table users drop column if exists is_break_glass;
