ALTER TABLE `users` ADD `legacy_password_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_password_pending` boolean DEFAULT false NOT NULL;