CREATE TABLE `campaigns` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(60) NOT NULL,
	`effect` varchar(32) NOT NULL,
	`config` json NOT NULL,
	`starts_at` datetime NOT NULL,
	`ends_at` datetime,
	`enabled` boolean NOT NULL DEFAULT true,
	`priority` smallint unsigned NOT NULL DEFAULT 0,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`created_by` int unsigned,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `campaigns_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_campaign_window` ON `campaigns` (`enabled`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `idx_campaign_effect` ON `campaigns` (`effect`,`priority`);