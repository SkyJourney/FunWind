CREATE TABLE `event_log` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`event_name` varchar(64) NOT NULL,
	`payload` json,
	`actor_id` int unsigned,
	`source` varchar(64),
	`error_json` json,
	`created_at` datetime NOT NULL,
	CONSTRAINT `event_log_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `module_state` (
	`module_id` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `module_state_module_id_pk` PRIMARY KEY(`module_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_el_name_time` ON `event_log` (`event_name`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_el_time` ON `event_log` (`created_at`);