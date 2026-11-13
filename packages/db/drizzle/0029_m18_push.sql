CREATE TABLE `push_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`kind` varchar(16) NOT NULL,
	`scene` varchar(48) NOT NULL,
	`endpoint` varchar(500) NOT NULL,
	`user_id` int unsigned,
	`title` varchar(255) NOT NULL,
	`status` enum('sent','failed') NOT NULL,
	`error` varchar(500),
	`message_id` varchar(255),
	`duration_ms` int unsigned,
	`created_at` datetime NOT NULL,
	CONSTRAINT `push_log_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`endpoint` varchar(500) NOT NULL,
	`p256dh` varchar(255) NOT NULL,
	`auth` varchar(255) NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `push_subscriptions_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_push_subscriptions_endpoint` UNIQUE(`endpoint`)
);
--> statement-breakpoint
CREATE INDEX `idx_push_log_time` ON `push_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_push_log_user` ON `push_log` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_push_log_status` ON `push_log` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_push_log_scene` ON `push_log` (`scene`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_push_subscriptions_user` ON `push_subscriptions` (`user_id`,`created_at`);