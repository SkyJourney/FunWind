ALTER TABLE `groups` MODIFY COLUMN `id` mediumint unsigned NOT NULL;--> statement-breakpoint
ALTER TABLE `migration_state` MODIFY COLUMN `rows_written` bigint unsigned NOT NULL;--> statement-breakpoint
ALTER TABLE `migration_state` MODIFY COLUMN `duration_ms` bigint unsigned NOT NULL;--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `group_id` mediumint unsigned NOT NULL;