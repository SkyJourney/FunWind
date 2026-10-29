CREATE TABLE `emoji_groups` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(50) NOT NULL,
	`sort` int NOT NULL DEFAULT 0,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `emoji_groups_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_emoji_groups_name` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `emojis` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`group_id` int unsigned NOT NULL,
	`name` varchar(50) NOT NULL,
	`keywords` varchar(200) NOT NULL DEFAULT '',
	`ext` varchar(8) NOT NULL,
	`storage_key` varchar(66),
	`width` smallint unsigned,
	`height` smallint unsigned,
	`sort` int NOT NULL DEFAULT 0,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `emojis_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_emojis_group` ON `emojis` (`group_id`,`sort`,`id`);