CREATE TABLE `reports` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`post_id` int unsigned NOT NULL,
	`reporter_id` int unsigned NOT NULL,
	`reason` varchar(255) NOT NULL DEFAULT '',
	`status` enum('pending','resolved','dismissed') NOT NULL DEFAULT 'pending',
	`handled_by` int unsigned,
	`handled_note` varchar(255),
	`created_at` datetime NOT NULL,
	`handled_at` datetime,
	CONSTRAINT `reports_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_reports_post_reporter` UNIQUE(`post_id`,`reporter_id`)
);
--> statement-breakpoint
ALTER TABLE `notifications` ADD `dedup_key` varchar(96);--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `uq_nf_dedup` UNIQUE(`dedup_key`);--> statement-breakpoint
CREATE INDEX `idx_reports_status` ON `reports` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_posts_state_created` ON `posts` (`state`,`created_at`);