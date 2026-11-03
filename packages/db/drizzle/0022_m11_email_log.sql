CREATE TABLE `email_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`kind` varchar(16) NOT NULL,
	`scene` varchar(48) NOT NULL,
	`to_email` varchar(255) NOT NULL,
	`user_id` int unsigned,
	`subject` varchar(255) NOT NULL,
	`status` enum('sent','failed') NOT NULL,
	`error` varchar(500),
	`message_id` varchar(255),
	`duration_ms` int unsigned,
	`created_at` datetime NOT NULL,
	CONSTRAINT `email_log_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_email_log_time` ON `email_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_email_log_user` ON `email_log` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_email_log_status` ON `email_log` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_email_log_scene` ON `email_log` (`scene`,`created_at`);