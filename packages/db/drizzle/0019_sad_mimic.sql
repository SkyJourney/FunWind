CREATE TABLE `account_deletion_tokens` (
	`id` varchar(64) NOT NULL,
	`user_id` int unsigned NOT NULL,
	`purpose` enum('request','access') NOT NULL,
	`email_key_snapshot` varchar(64) NOT NULL,
	`created_at` datetime NOT NULL,
	`expires_at` datetime NOT NULL,
	`used_at` datetime,
	CONSTRAINT `account_deletion_tokens_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_appeals` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`target_type` enum('restriction','account_deletion') NOT NULL,
	`target_id` int unsigned NOT NULL,
	`reason` varchar(2000) NOT NULL,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`handled_by` int unsigned,
	`handled_at` datetime,
	`result` varchar(1000),
	`created_at` datetime NOT NULL,
	CONSTRAINT `user_appeals_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `messages` MODIFY COLUMN `sender_id` int unsigned;--> statement-breakpoint
ALTER TABLE `account_deletion_requests` ADD `verification_method` enum('password','verified_email') DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE `account_deletion_requests` ADD `access_token_hash` varchar(64);--> statement-breakpoint
ALTER TABLE `account_deletion_requests` ADD `access_expires_at` datetime;--> statement-breakpoint
CREATE INDEX `idx_adt_user_purpose` ON `account_deletion_tokens` (`user_id`,`purpose`);--> statement-breakpoint
CREATE INDEX `idx_adt_expires` ON `account_deletion_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_user_appeals_user_status` ON `user_appeals` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_user_appeals_target` ON `user_appeals` (`target_type`,`target_id`,`status`);