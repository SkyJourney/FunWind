CREATE TABLE `email_tokens` (
	`id` varchar(64) NOT NULL,
	`purpose` enum('reset','verify','claim') NOT NULL,
	`user_id` int unsigned NOT NULL,
	`created_at` datetime NOT NULL,
	`expires_at` datetime NOT NULL,
	`used_at` datetime,
	CONSTRAINT `email_tokens_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invite_codes` (
	`code` varchar(32) NOT NULL,
	`created_by` int unsigned,
	`used_by` int unsigned,
	`used_at` datetime,
	`expires_at` datetime,
	`batch` varchar(64) NOT NULL DEFAULT '',
	`created_at` datetime NOT NULL,
	CONSTRAINT `invite_codes_code_pk` PRIMARY KEY(`code`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(64) NOT NULL,
	`user_id` int unsigned NOT NULL,
	`created_at` datetime NOT NULL,
	`expires_at` datetime NOT NULL,
	`last_seen_at` datetime,
	`ip` varchar(64),
	`user_agent` varchar(255),
	CONSTRAINT `sessions_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `site_settings` (
	`key` varchar(64) NOT NULL,
	`value` json,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `site_settings_key_pk` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `user_bans` (
	`id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`type_id` varchar(20) NOT NULL DEFAULT '',
	`fid` int unsigned NOT NULL DEFAULT 0,
	`end_time` datetime,
	`reason` varchar(80) NOT NULL DEFAULT '',
	`created_by` int unsigned NOT NULL DEFAULT 0,
	`created_at` datetime,
	`raw` json,
	CONSTRAINT `user_bans_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified_at` datetime;--> statement-breakpoint
CREATE INDEX `idx_et_user` ON `email_tokens` (`user_id`,`purpose`);--> statement-breakpoint
CREATE INDEX `idx_ic_batch` ON `invite_codes` (`batch`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_ub_user` ON `user_bans` (`user_id`);