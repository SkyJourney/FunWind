CREATE TABLE `file_uploads` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`file_id` int unsigned NOT NULL,
	`size_bytes` bigint unsigned NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL,
	CONSTRAINT `file_uploads_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `attachments` ADD `kind` enum('download','inline') DEFAULT 'download' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_uploads_user_created` ON `file_uploads` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_uploads_file` ON `file_uploads` (`file_id`);