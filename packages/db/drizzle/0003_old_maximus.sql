CREATE TABLE `topic_type` (
	`id` int unsigned NOT NULL,
	`fid` int unsigned NOT NULL DEFAULT 0,
	`name` varchar(255) NOT NULL DEFAULT '',
	`parent_id` int unsigned NOT NULL DEFAULT 0,
	`logo` varchar(255) NOT NULL DEFAULT '',
	`vieworder` tinyint NOT NULL DEFAULT 0,
	`issys` tinyint NOT NULL DEFAULT 0,
	`raw` json,
	CONSTRAINT `topic_type_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_tt_fid` ON `topic_type` (`fid`);