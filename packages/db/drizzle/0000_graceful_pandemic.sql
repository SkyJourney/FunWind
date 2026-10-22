CREATE TABLE `attachments` (
	`id` int unsigned NOT NULL,
	`thread_id` int unsigned,
	`post_id` int unsigned,
	`uploader_id` int unsigned NOT NULL DEFAULT 0,
	`filename` varchar(255) NOT NULL DEFAULT '',
	`type` varchar(20) NOT NULL DEFAULT '',
	`size_kb` int unsigned NOT NULL DEFAULT 0,
	`path` varchar(255) NOT NULL DEFAULT '',
	`has_thumb` boolean NOT NULL DEFAULT false,
	`width` smallint unsigned NOT NULL DEFAULT 0,
	`height` smallint unsigned NOT NULL DEFAULT 0,
	`downloads` int unsigned NOT NULL DEFAULT 0,
	`cost` int unsigned NOT NULL DEFAULT 0,
	`special` tinyint NOT NULL DEFAULT 0,
	`created_at` datetime,
	`raw` json,
	CONSTRAINT `attachments_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `credit_logs` (
	`id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL DEFAULT 0,
	`credit_type` varchar(8) NOT NULL DEFAULT '',
	`delta` int NOT NULL DEFAULT 0,
	`log_type` varchar(40) NOT NULL DEFAULT '',
	`description` varchar(255) NOT NULL DEFAULT '',
	`created_at` datetime,
	CONSTRAINT `credit_logs_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `emoticon_categories` (
	`id` int unsigned NOT NULL,
	`name` varchar(64) NOT NULL DEFAULT '',
	`folder` varchar(32) NOT NULL DEFAULT '',
	`apps` varchar(64) NOT NULL DEFAULT '',
	`orderid` int unsigned NOT NULL DEFAULT 0,
	`is_open` boolean NOT NULL DEFAULT true,
	CONSTRAINT `emoticon_categories_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `emoticons` (
	`id` int unsigned NOT NULL,
	`category_id` int unsigned NOT NULL DEFAULT 0,
	`folder` varchar(32) NOT NULL DEFAULT '',
	`icon` varchar(64) NOT NULL DEFAULT '',
	`is_used` boolean NOT NULL DEFAULT true,
	CONSTRAINT `emoticons_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `forums` (
	`id` smallint unsigned NOT NULL,
	`parent_id` smallint unsigned NOT NULL DEFAULT 0,
	`type` enum('category','forum','sub','sub2') NOT NULL DEFAULT 'forum',
	`name` varchar(255) NOT NULL,
	`name_style` varchar(255) NOT NULL DEFAULT '',
	`description` text,
	`summary` text,
	`vieworder` smallint NOT NULL DEFAULT 0,
	`is_show` boolean NOT NULL DEFAULT true,
	`managers` json,
	`icon` varchar(100) NOT NULL DEFAULT '',
	`logo` varchar(100) NOT NULL DEFAULT '',
	`thread_count` int unsigned NOT NULL DEFAULT 0,
	`post_count` int unsigned NOT NULL DEFAULT 0,
	`raw` json,
	CONSTRAINT `forums_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` int unsigned NOT NULL,
	`name` varchar(64) NOT NULL,
	`type` enum('default','member','system','special','vip') NOT NULL DEFAULT 'member',
	`points` int unsigned NOT NULL DEFAULT 0,
	`image` varchar(64) NOT NULL DEFAULT '',
	`raw` json,
	CONSTRAINT `groups_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `medals` (
	`id` int unsigned NOT NULL,
	`name` varchar(64) NOT NULL DEFAULT '',
	`path` varchar(64) NOT NULL DEFAULT '',
	`image` varchar(64) NOT NULL DEFAULT '',
	`icon` varchar(64) NOT NULL DEFAULT '',
	`description` varchar(255) NOT NULL DEFAULT '',
	`medal_type` tinyint NOT NULL DEFAULT 1,
	`receive_type` tinyint NOT NULL DEFAULT 1,
	`medal_gids` varchar(64) NOT NULL DEFAULT '',
	`award_type` tinyint NOT NULL DEFAULT 1,
	`award_condition` smallint NOT NULL DEFAULT 0,
	`expired_days` smallint NOT NULL DEFAULT 0,
	`is_open` boolean NOT NULL DEFAULT true,
	`vieworder` tinyint NOT NULL DEFAULT 0,
	`raw` json,
	CONSTRAINT `medals_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `message_dialogs` (
	`id` int unsigned NOT NULL,
	`from_uid` int unsigned NOT NULL DEFAULT 0,
	`to_uid` int unsigned NOT NULL DEFAULT 0,
	`unread_count` smallint unsigned NOT NULL DEFAULT 0,
	`message_count` int unsigned NOT NULL DEFAULT 0,
	`last_message` text,
	`modified_at` datetime,
	CONSTRAINT `message_dialogs_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `migration_state` (
	`entity` varchar(64) NOT NULL,
	`rows_written` int unsigned NOT NULL DEFAULT 0,
	`duration_ms` int unsigned NOT NULL DEFAULT 0,
	`finished_at` datetime,
	`note` varchar(255) NOT NULL DEFAULT '',
	CONSTRAINT `migration_state_entity_pk` PRIMARY KEY(`entity`)
);
--> statement-breakpoint
CREATE TABLE `poll_options` (
	`id` int unsigned NOT NULL,
	`poll_id` int unsigned NOT NULL,
	`voted_num` int unsigned NOT NULL DEFAULT 0,
	`content` varchar(255) NOT NULL DEFAULT '',
	`image` varchar(255) NOT NULL DEFAULT '',
	CONSTRAINT `poll_options_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `poll_voters` (
	`poll_id` int unsigned NOT NULL,
	`option_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`created_at` datetime,
	CONSTRAINT `poll_voters_poll_id_option_id_user_id_pk` PRIMARY KEY(`poll_id`,`option_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `polls` (
	`id` int unsigned NOT NULL,
	`thread_id` int unsigned,
	`voter_num` int unsigned NOT NULL DEFAULT 0,
	`isafter_view` boolean NOT NULL DEFAULT false,
	`isinclude_img` boolean NOT NULL DEFAULT false,
	`option_limit` smallint unsigned NOT NULL DEFAULT 0,
	`expired_time` datetime,
	`creator_id` int unsigned NOT NULL DEFAULT 0,
	`created_at` datetime,
	`raw` json,
	CONSTRAINT `polls_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` int unsigned NOT NULL,
	`thread_id` int unsigned NOT NULL,
	`author_id` int unsigned NOT NULL DEFAULT 0,
	`floor` int unsigned NOT NULL DEFAULT 0,
	`reply_to_pid` int unsigned,
	`subject` varchar(100) NOT NULL DEFAULT '',
	`content_md` mediumtext,
	`content_raw` mediumtext,
	`usehtml` boolean NOT NULL DEFAULT false,
	`like_count` int unsigned NOT NULL DEFAULT 0,
	`status` tinyint NOT NULL DEFAULT 0,
	`created_at` datetime,
	`modified_at` datetime,
	`raw` json,
	CONSTRAINT `posts_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `private_messages` (
	`id` int unsigned NOT NULL,
	`from_uid` int unsigned NOT NULL DEFAULT 0,
	`to_uid` int unsigned NOT NULL DEFAULT 0,
	`content` mediumtext,
	`created_at` datetime,
	`raw` json,
	CONSTRAINT `private_messages_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` int unsigned NOT NULL,
	`forum_id` smallint unsigned NOT NULL DEFAULT 0,
	`author_id` int unsigned NOT NULL DEFAULT 0,
	`title` varchar(140) NOT NULL DEFAULT '',
	`type_id` int unsigned NOT NULL DEFAULT 0,
	`digest` tinyint NOT NULL DEFAULT 0,
	`topped` tinyint NOT NULL DEFAULT 0,
	`special` varchar(20) NOT NULL DEFAULT '',
	`reply_count` int unsigned NOT NULL DEFAULT 0,
	`view_count` int unsigned NOT NULL DEFAULT 0,
	`like_count` int unsigned NOT NULL DEFAULT 0,
	`attach_count` smallint unsigned NOT NULL DEFAULT 0,
	`content_md` mediumtext,
	`content_raw` mediumtext,
	`usehtml` boolean NOT NULL DEFAULT false,
	`tags` varchar(255) NOT NULL DEFAULT '',
	`is_spam` boolean NOT NULL DEFAULT false,
	`status` tinyint NOT NULL DEFAULT 0,
	`created_at` datetime,
	`last_post_at` datetime,
	`last_post_user_id` int unsigned NOT NULL DEFAULT 0,
	`raw` json,
	CONSTRAINT `threads_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_medals` (
	`user_id` int unsigned NOT NULL,
	`medal_id` int unsigned NOT NULL,
	`counts` int unsigned NOT NULL DEFAULT 0,
	`expired_time` datetime,
	CONSTRAINT `user_medals_user_id_medal_id_pk` PRIMARY KEY(`user_id`,`medal_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int unsigned NOT NULL,
	`username` varchar(64) NOT NULL,
	`email` varchar(128) NOT NULL DEFAULT '',
	`password_hash` varchar(255),
	`group_id` int unsigned NOT NULL DEFAULT 0,
	`gender` tinyint NOT NULL DEFAULT 0,
	`location` varchar(100) NOT NULL DEFAULT '',
	`homepage` varchar(200) NOT NULL DEFAULT '',
	`signature_md` text,
	`profile` text,
	`post_count` int unsigned NOT NULL DEFAULT 0,
	`digest_count` int unsigned NOT NULL DEFAULT 0,
	`followers` int unsigned NOT NULL DEFAULT 0,
	`fans` int unsigned NOT NULL DEFAULT 0,
	`credits` json,
	`online_time` int unsigned NOT NULL DEFAULT 0,
	`is_spam` boolean NOT NULL DEFAULT false,
	`status` smallint NOT NULL DEFAULT 0,
	`created_at` datetime,
	`last_visit_at` datetime,
	`last_post_at` datetime,
	`raw` json,
	CONSTRAINT `users_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_users_username` UNIQUE(`username`)
);
--> statement-breakpoint
CREATE INDEX `idx_att_thread` ON `attachments` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_att_post` ON `attachments` (`post_id`);--> statement-breakpoint
CREATE INDEX `idx_att_uploader` ON `attachments` (`uploader_id`);--> statement-breakpoint
CREATE INDEX `idx_cl_user` ON `credit_logs` (`user_id`,`credit_type`);--> statement-breakpoint
CREATE INDEX `idx_cl_time` ON `credit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_emo_cat` ON `emoticons` (`category_id`);--> statement-breakpoint
CREATE INDEX `idx_forums_parent` ON `forums` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_forums_order` ON `forums` (`vieworder`);--> statement-breakpoint
CREATE INDEX `idx_md_to` ON `message_dialogs` (`to_uid`);--> statement-breakpoint
CREATE INDEX `idx_po_poll` ON `poll_options` (`poll_id`);--> statement-breakpoint
CREATE INDEX `idx_pv_user` ON `poll_voters` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_polls_thread` ON `polls` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_posts_thread` ON `posts` (`thread_id`,`floor`);--> statement-breakpoint
CREATE INDEX `idx_posts_author` ON `posts` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_posts_reply` ON `posts` (`reply_to_pid`);--> statement-breakpoint
CREATE INDEX `idx_pm_from` ON `private_messages` (`from_uid`);--> statement-breakpoint
CREATE INDEX `idx_pm_to` ON `private_messages` (`to_uid`);--> statement-breakpoint
CREATE INDEX `idx_threads_forum` ON `threads` (`forum_id`,`is_spam`,`last_post_at`);--> statement-breakpoint
CREATE INDEX `idx_threads_author` ON `threads` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_threads_created` ON `threads` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_threads_digest` ON `threads` (`digest`);--> statement-breakpoint
CREATE INDEX `idx_um_medal` ON `user_medals` (`medal_id`);--> statement-breakpoint
CREATE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_group` ON `users` (`group_id`);--> statement-breakpoint
CREATE INDEX `idx_users_spam` ON `users` (`is_spam`);--> statement-breakpoint
CREATE INDEX `idx_users_created` ON `users` (`created_at`);