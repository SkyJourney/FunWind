CREATE TABLE `permissions` (
	`key` varchar(64) NOT NULL,
	`resource` varchar(32) NOT NULL,
	`level` enum('read','write','manage'),
	`description` varchar(255) NOT NULL DEFAULT '',
	`legacy_key` varchar(64),
	`condition_params` json,
	CONSTRAINT `permissions_key_pk` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `role_grants` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`role_key` varchar(64) NOT NULL,
	`permission_key` varchar(64) NOT NULL,
	`scope_type` enum('global','forum') NOT NULL,
	`forum_id` int unsigned,
	CONSTRAINT `role_grants_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_rg_grant` UNIQUE(`role_key`,`permission_key`,`scope_type`,`forum_id`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`key` varchar(64) NOT NULL,
	`name` varchar(64) NOT NULL,
	`kind` enum('builtin','custom') NOT NULL,
	`description` varchar(255) NOT NULL DEFAULT '',
	CONSTRAINT `roles_key_pk` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`role_key` varchar(64) NOT NULL,
	`scope_type` enum('global','forum') NOT NULL,
	`forum_id` int unsigned,
	`expires_at` datetime,
	`granted_by` int unsigned,
	`granted_at` datetime NOT NULL,
	CONSTRAINT `user_roles_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ur_assignment` UNIQUE(`user_id`,`role_key`,`scope_type`,`forum_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_rg_perm_scope` ON `role_grants` (`permission_key`,`scope_type`,`forum_id`);--> statement-breakpoint
CREATE INDEX `idx_ur_user` ON `user_roles` (`user_id`);