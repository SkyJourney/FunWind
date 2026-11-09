CREATE TABLE `ops_tasks` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`task_key` varchar(64) NOT NULL,
	`name` varchar(60) NOT NULL,
	`executor` varchar(32) NOT NULL,
	`params` json NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `ops_tasks_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ops_task_key` UNIQUE(`task_key`)
);
--> statement-breakpoint
CREATE TABLE `ops_triggers` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`task_key` varchar(64) NOT NULL,
	`kind` enum('cron','once','manual') NOT NULL,
	`expr` varchar(64),
	`enabled` boolean NOT NULL DEFAULT true,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `ops_triggers_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_ops_trigger_task` ON `ops_triggers` (`task_key`);