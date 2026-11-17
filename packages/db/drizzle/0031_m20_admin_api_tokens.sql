CREATE TABLE `admin_api_tokens` (
	`id` varchar(64) NOT NULL,
	`user_id` int unsigned NOT NULL,
	`name` varchar(64) NOT NULL,
	`suffix` varchar(8) NOT NULL,
	`created_at` datetime NOT NULL,
	`expires_at` datetime NOT NULL,
	`last_used_at` datetime,
	`last_used_ip` varchar(64),
	`revoked_at` datetime,
	`created_via` varchar(16) NOT NULL DEFAULT 'admin',
	CONSTRAINT `admin_api_tokens_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_aat_user` ON `admin_api_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_aat_expires` ON `admin_api_tokens` (`expires_at`);