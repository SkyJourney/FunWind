CREATE TABLE `theme_packages` (
	`id` varchar(32) NOT NULL,
	`name` varchar(60) NOT NULL,
	`description` varchar(200) NOT NULL DEFAULT '',
	`schema_version` smallint NOT NULL DEFAULT 1,
	`definition` json NOT NULL,
	`assets` json NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`is_builtin` boolean NOT NULL DEFAULT false,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `theme_packages_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_theme_packages_enabled` ON `theme_packages` (`enabled`);