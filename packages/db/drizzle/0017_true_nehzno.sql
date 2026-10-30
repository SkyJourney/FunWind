CREATE TABLE `account_deletion_requests` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`status` enum('pending','cancelled','completed') NOT NULL DEFAULT 'pending',
	`requested_at` datetime NOT NULL,
	`scheduled_at` datetime NOT NULL,
	`cancelled_at` datetime,
	`completed_at` datetime,
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`last_attempt_at` datetime,
	`last_error_code` varchar(64),
	CONSTRAINT `account_deletion_requests_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `user_restrictions` MODIFY COLUMN `kind` enum('ban','forum_ban','mute','no_avatar','no_signature') NOT NULL;--> statement-breakpoint
ALTER TABLE `email_tokens` ADD `email_key_snapshot` varchar(64);--> statement-breakpoint
CREATE INDEX `idx_adr_user_status` ON `account_deletion_requests` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_adr_status_scheduled` ON `account_deletion_requests` (`status`,`scheduled_at`);