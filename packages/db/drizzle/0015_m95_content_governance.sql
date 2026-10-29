ALTER TABLE `posts` MODIFY COLUMN `state` enum('visible','pending','rejected','hidden','deleted','disabled') NOT NULL DEFAULT 'visible';--> statement-breakpoint
ALTER TABLE `threads` MODIFY COLUMN `state` enum('visible','pending','rejected','hidden','deleted','disabled') NOT NULL DEFAULT 'visible';--> statement-breakpoint
ALTER TABLE `forums` DROP COLUMN `icon`;--> statement-breakpoint
ALTER TABLE `forums` ADD `icon_key` varchar(128);
