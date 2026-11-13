CREATE TABLE `rum_samples` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`kind` enum('vital','error') NOT NULL,
	`name` varchar(32) NOT NULL,
	`value` int unsigned NOT NULL,
	`route` varchar(200) NOT NULL,
	`detail` varchar(200),
	`created_at` datetime NOT NULL,
	CONSTRAINT `rum_samples_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_rum_samples_time` ON `rum_samples` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rum_samples_kind` ON `rum_samples` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rum_samples_name` ON `rum_samples` (`name`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rum_samples_route` ON `rum_samples` (`route`,`created_at`);