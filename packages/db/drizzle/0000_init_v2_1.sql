CREATE TABLE `announcement_reads` (
	`user_id` int unsigned NOT NULL,
	`announcement_id` int unsigned NOT NULL,
	`read_at` datetime NOT NULL,
	CONSTRAINT `announcement_reads_user_id_announcement_id_pk` PRIMARY KEY(`user_id`,`announcement_id`)
);
--> statement-breakpoint
CREATE TABLE `announcements` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`title` varchar(200) NOT NULL,
	`body_md` text NOT NULL,
	`level` enum('info','important') NOT NULL DEFAULT 'info',
	`audience` enum('all','members') NOT NULL DEFAULT 'all',
	`show_banner` boolean NOT NULL DEFAULT false,
	`starts_at` datetime NOT NULL,
	`ends_at` datetime,
	`created_by` int unsigned NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `announcements_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`post_id` int unsigned NOT NULL,
	`file_id` int unsigned NOT NULL,
	`uploader_id` int unsigned NOT NULL,
	`original_name` varchar(255) NOT NULL DEFAULT '',
	`downloads` int unsigned NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL,
	CONSTRAINT `attachments_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`actor_id` int unsigned,
	`action` varchar(64) NOT NULL,
	`target_type` varchar(32) NOT NULL DEFAULT '',
	`target_id` varchar(64) NOT NULL DEFAULT '',
	`before_json` json,
	`after_json` json,
	`ip` varchar(64),
	`created_at` datetime NOT NULL,
	CONSTRAINT `audit_log_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `badges` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`key` varchar(48) NOT NULL,
	`name` varchar(64) NOT NULL,
	`description` varchar(255) NOT NULL DEFAULT '',
	`icon_file_id` int unsigned,
	`kind` enum('team','honor') NOT NULL DEFAULT 'honor',
	`sort_order` smallint NOT NULL DEFAULT 0,
	`is_active` boolean NOT NULL DEFAULT true,
	CONSTRAINT `badges_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_badges_key` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `checkins` (
	`user_id` int unsigned NOT NULL,
	`checkin_date` date NOT NULL,
	`reward` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `checkins_user_id_checkin_date_pk` PRIMARY KEY(`user_id`,`checkin_date`)
);
--> statement-breakpoint
CREATE TABLE `content_reviews` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`post_id` int unsigned NOT NULL,
	`reviewer_id` int unsigned NOT NULL,
	`decision` enum('approved','rejected') NOT NULL,
	`note` varchar(255) NOT NULL DEFAULT '',
	`created_at` datetime NOT NULL,
	CONSTRAINT `content_reviews_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_members` (
	`conversation_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`last_read_message_id` bigint unsigned,
	`deleted_at` datetime,
	CONSTRAINT `conversation_members_conversation_id_user_id_pk` PRIMARY KEY(`conversation_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`kind` enum('direct') NOT NULL DEFAULT 'direct',
	`pair_key` varchar(32) NOT NULL,
	`last_message_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `conversations_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_conv_pair` UNIQUE(`pair_key`)
);
--> statement-breakpoint
CREATE TABLE `email_tokens` (
	`id` varchar(64) NOT NULL,
	`purpose` enum('reset','verify','claim') NOT NULL,
	`user_id` int unsigned NOT NULL,
	`created_at` datetime NOT NULL,
	`expires_at` datetime NOT NULL,
	`used_at` datetime,
	CONSTRAINT `email_tokens_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
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
CREATE TABLE `files` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`sha256` char(64) NOT NULL,
	`storage_key` varchar(128) NOT NULL,
	`size_bytes` bigint unsigned NOT NULL DEFAULT 0,
	`mime` varchar(100) NOT NULL DEFAULT '',
	`width` smallint unsigned,
	`height` smallint unsigned,
	`created_at` datetime NOT NULL,
	CONSTRAINT `files_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_files_sha256` UNIQUE(`sha256`),
	CONSTRAINT `uq_files_storage_key` UNIQUE(`storage_key`)
);
--> statement-breakpoint
CREATE TABLE `follows` (
	`user_id` int unsigned NOT NULL,
	`target_type` enum('user','forum') NOT NULL,
	`target_id` int unsigned NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `follows_user_id_target_type_target_id_pk` PRIMARY KEY(`user_id`,`target_type`,`target_id`)
);
--> statement-breakpoint
CREATE TABLE `forum_prefixes` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`forum_id` int unsigned NOT NULL,
	`name` varchar(64) NOT NULL,
	`sort_order` smallint NOT NULL DEFAULT 0,
	CONSTRAINT `forum_prefixes_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `forums` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`parent_id` int unsigned NOT NULL DEFAULT 0,
	`path` varchar(255) NOT NULL DEFAULT '/',
	`depth` tinyint unsigned NOT NULL DEFAULT 1,
	`kind` enum('section','forum') NOT NULL DEFAULT 'forum',
	`name` varchar(100) NOT NULL,
	`description` text,
	`icon` varchar(100) NOT NULL DEFAULT '',
	`sort_order` int NOT NULL DEFAULT 0,
	`read_policy` enum('inherit','public','members','restricted') NOT NULL DEFAULT 'inherit',
	`write_policy` enum('inherit','members','restricted') NOT NULL DEFAULT 'inherit',
	`review_policy` enum('inherit','none','threads','all') NOT NULL DEFAULT 'inherit',
	`is_listed` boolean NOT NULL DEFAULT true,
	`is_archived` boolean NOT NULL DEFAULT false,
	`thread_count` int unsigned NOT NULL DEFAULT 0,
	`post_count` int unsigned NOT NULL DEFAULT 0,
	`last_post_id` int unsigned,
	`last_posted_at` datetime,
	CONSTRAINT `forums_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gate_unlocks` (
	`gate_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`price_paid` int unsigned NOT NULL DEFAULT 0,
	`author_income` int unsigned NOT NULL DEFAULT 0,
	`ledger_id` bigint unsigned,
	`unlocked_at` datetime NOT NULL,
	CONSTRAINT `gate_unlocks_gate_id_user_id_pk` PRIMARY KEY(`gate_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `invite_codes` (
	`code` varchar(32) NOT NULL,
	`created_by` int unsigned,
	`used_by` int unsigned,
	`used_at` datetime,
	`expires_at` datetime,
	`batch` varchar(64) NOT NULL DEFAULT '',
	`created_at` datetime NOT NULL,
	CONSTRAINT `invite_codes_code_pk` PRIMARY KEY(`code`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`conversation_id` int unsigned NOT NULL,
	`sender_id` int unsigned NOT NULL,
	`body` text NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `messages_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `module_state` (
	`module_id` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `module_state_module_id_pk` PRIMARY KEY(`module_id`)
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`user_id` int unsigned NOT NULL,
	`type` varchar(48) NOT NULL,
	`channel` enum('in_app','email','push') NOT NULL,
	`enabled` boolean NOT NULL,
	CONSTRAINT `notification_preferences_user_id_type_channel_pk` PRIMARY KEY(`user_id`,`type`,`channel`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`category` enum('interaction','message','moderation','account') NOT NULL,
	`type` varchar(48) NOT NULL,
	`actor_id` int unsigned,
	`target_type` varchar(32) NOT NULL DEFAULT '',
	`target_id` bigint unsigned NOT NULL DEFAULT 0,
	`group_key` varchar(96),
	`data` json,
	`read_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `notifications_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`key` varchar(64) NOT NULL,
	`resource` varchar(32) NOT NULL,
	`level` enum('read','write','manage'),
	`description` varchar(255) NOT NULL DEFAULT '',
	CONSTRAINT `permissions_key_pk` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `point_accounts` (
	`user_id` int unsigned NOT NULL,
	`balance` int unsigned NOT NULL DEFAULT 0,
	`lifetime_earned` bigint unsigned NOT NULL DEFAULT 0,
	`lifetime_spent` bigint unsigned NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `point_accounts_user_id_pk` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `point_ledger` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`delta` int NOT NULL,
	`balance_after` int unsigned NOT NULL,
	`channel` varchar(48) NOT NULL,
	`ref_type` varchar(32),
	`ref_id` bigint unsigned,
	`idempotency_key` varchar(96) NOT NULL,
	`note` varchar(255) NOT NULL DEFAULT '',
	`created_at` datetime NOT NULL,
	CONSTRAINT `point_ledger_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_pl_idem` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `poll_options` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`poll_id` int unsigned NOT NULL,
	`content` varchar(255) NOT NULL,
	`vote_count` int unsigned NOT NULL DEFAULT 0,
	`sort_order` smallint NOT NULL DEFAULT 0,
	CONSTRAINT `poll_options_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `poll_votes` (
	`poll_id` int unsigned NOT NULL,
	`option_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `poll_votes_poll_id_option_id_user_id_pk` PRIMARY KEY(`poll_id`,`option_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `polls` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`thread_id` int unsigned NOT NULL,
	`option_limit` smallint unsigned NOT NULL DEFAULT 1,
	`ends_at` datetime,
	`result_visibility` enum('always','after_vote') NOT NULL DEFAULT 'always',
	`voter_count` int unsigned NOT NULL DEFAULT 0,
	`created_by` int unsigned NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `polls_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_polls_thread` UNIQUE(`thread_id`)
);
--> statement-breakpoint
CREATE TABLE `post_gates` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`post_id` int unsigned NOT NULL,
	`gate_key` varchar(16) NOT NULL,
	`conditions` json NOT NULL,
	`match_mode` enum('all','any') NOT NULL DEFAULT 'all',
	`hidden_md` mediumtext NOT NULL,
	`unlock_count` int unsigned NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `post_gates_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_pg_post_key` UNIQUE(`post_id`,`gate_key`)
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`thread_id` int unsigned NOT NULL,
	`floor` int unsigned NOT NULL,
	`author_id` int unsigned NOT NULL,
	`body_md` mediumtext,
	`reply_to_post_id` int unsigned,
	`has_gate` boolean NOT NULL DEFAULT false,
	`state` enum('visible','pending','rejected','hidden','deleted') NOT NULL DEFAULT 'visible',
	`like_count` int unsigned NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL,
	`edited_at` datetime,
	CONSTRAINT `posts_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_posts_thread_floor` UNIQUE(`thread_id`,`floor`)
);
--> statement-breakpoint
CREATE TABLE `reactions` (
	`user_id` int unsigned NOT NULL,
	`post_id` int unsigned NOT NULL,
	`kind` varchar(16) NOT NULL DEFAULT 'like',
	`created_at` datetime NOT NULL,
	CONSTRAINT `reactions_user_id_post_id_kind_pk` PRIMARY KEY(`user_id`,`post_id`,`kind`)
);
--> statement-breakpoint
CREATE TABLE `role_grants` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`role_key` varchar(64) NOT NULL,
	`permission_key` varchar(64) NOT NULL,
	`scope_id` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `role_grants_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_rg_grant` UNIQUE(`role_key`,`permission_key`,`scope_id`)
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
CREATE TABLE `sessions` (
	`id` varchar(64) NOT NULL,
	`user_id` int unsigned NOT NULL,
	`created_at` datetime NOT NULL,
	`expires_at` datetime NOT NULL,
	`last_seen_at` datetime,
	`ip` varchar(64),
	`user_agent` varchar(255),
	CONSTRAINT `sessions_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `site_settings` (
	`key` varchar(64) NOT NULL,
	`value` json,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `site_settings_key_pk` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(64) NOT NULL,
	`thread_count` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `tags_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tags_name` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `thread_tags` (
	`thread_id` int unsigned NOT NULL,
	`tag_id` int unsigned NOT NULL,
	CONSTRAINT `thread_tags_thread_id_tag_id_pk` PRIMARY KEY(`thread_id`,`tag_id`)
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`forum_id` int unsigned NOT NULL,
	`author_id` int unsigned NOT NULL,
	`title` varchar(255) NOT NULL,
	`prefix_id` int unsigned,
	`kind` enum('normal','poll') NOT NULL DEFAULT 'normal',
	`first_post_id` int unsigned,
	`state` enum('visible','pending','rejected','hidden','deleted') NOT NULL DEFAULT 'visible',
	`pin_level` tinyint unsigned NOT NULL DEFAULT 0,
	`is_featured` boolean NOT NULL DEFAULT false,
	`is_locked` boolean NOT NULL DEFAULT false,
	`reply_count` int unsigned NOT NULL DEFAULT 0,
	`view_count` int unsigned NOT NULL DEFAULT 0,
	`last_post_id` int unsigned,
	`last_poster_id` int unsigned,
	`last_posted_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `threads_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_badges` (
	`user_id` int unsigned NOT NULL,
	`badge_id` int unsigned NOT NULL,
	`awarded_at` datetime NOT NULL,
	`awarded_by` int unsigned,
	`expires_at` datetime,
	CONSTRAINT `user_badges_user_id_badge_id_pk` PRIMARY KEY(`user_id`,`badge_id`)
);
--> statement-breakpoint
CREATE TABLE `user_profiles` (
	`user_id` int unsigned NOT NULL,
	`bio` text,
	`location` varchar(100) NOT NULL DEFAULT '',
	`website` varchar(200) NOT NULL DEFAULT '',
	`gender` tinyint NOT NULL DEFAULT 0,
	`birthday` date,
	`signature_md` text,
	`avatar_file_id` int unsigned,
	CONSTRAINT `user_profiles_user_id_pk` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `user_restrictions` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`kind` enum('ban','mute','no_avatar','no_signature') NOT NULL,
	`scope_id` int unsigned NOT NULL DEFAULT 0,
	`reason` varchar(255) NOT NULL DEFAULT '',
	`starts_at` datetime NOT NULL,
	`ends_at` datetime,
	`created_by` int unsigned,
	`created_at` datetime NOT NULL,
	CONSTRAINT `user_restrictions_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`role_key` varchar(64) NOT NULL,
	`scope_id` int unsigned NOT NULL DEFAULT 0,
	`expires_at` datetime,
	`granted_by` int unsigned,
	`granted_at` datetime NOT NULL,
	CONSTRAINT `user_roles_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ur_assignment` UNIQUE(`user_id`,`role_key`,`scope_id`)
);
--> statement-breakpoint
CREATE TABLE `user_stats` (
	`user_id` int unsigned NOT NULL,
	`thread_count` int unsigned NOT NULL DEFAULT 0,
	`post_count` int unsigned NOT NULL DEFAULT 0,
	`featured_count` int unsigned NOT NULL DEFAULT 0,
	`follower_count` int unsigned NOT NULL DEFAULT 0,
	`last_post_at` datetime,
	CONSTRAINT `user_stats_user_id_pk` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`username` varchar(64) NOT NULL,
	`username_key` varchar(64) NOT NULL,
	`email` varchar(128),
	`email_key` varchar(128),
	`password_hash` varchar(255),
	`email_verified_at` datetime,
	`state` enum('active','deleted') NOT NULL DEFAULT 'active',
	`created_at` datetime NOT NULL,
	`last_login_at` datetime,
	CONSTRAINT `users_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uq_users_username_key` UNIQUE(`username_key`),
	CONSTRAINT `uq_users_email_key` UNIQUE(`email_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_ar_announcement` ON `announcement_reads` (`announcement_id`);--> statement-breakpoint
CREATE INDEX `idx_ann_window` ON `announcements` (`starts_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `idx_att_post` ON `attachments` (`post_id`);--> statement-breakpoint
CREATE INDEX `idx_att_file` ON `attachments` (`file_id`);--> statement-breakpoint
CREATE INDEX `idx_att_uploader` ON `attachments` (`uploader_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_actor` ON `audit_log` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_target` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_time` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_cr_post` ON `content_reviews` (`post_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_cm_user` ON `conversation_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_et_user` ON `email_tokens` (`user_id`,`purpose`);--> statement-breakpoint
CREATE INDEX `idx_el_name_time` ON `event_log` (`event_name`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_el_time` ON `event_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_fl_target` ON `follows` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_fp_forum` ON `forum_prefixes` (`forum_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_forums_parent` ON `forums` (`parent_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_forums_path` ON `forums` (`path`);--> statement-breakpoint
CREATE INDEX `idx_gu_user` ON `gate_unlocks` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_ic_batch` ON `invite_codes` (`batch`);--> statement-breakpoint
CREATE INDEX `idx_msg_conv` ON `messages` (`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_nf_user_read` ON `notifications` (`user_id`,`read_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_nf_user_category` ON `notifications` (`user_id`,`category`,`id`);--> statement-breakpoint
CREATE INDEX `idx_nf_user_group` ON `notifications` (`user_id`,`group_key`,`read_at`);--> statement-breakpoint
CREATE INDEX `idx_pl_user` ON `point_ledger` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_pl_channel` ON `point_ledger` (`channel`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_po_poll` ON `poll_options` (`poll_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_pv_user` ON `poll_votes` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_posts_author` ON `posts` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_posts_reply_to` ON `posts` (`reply_to_post_id`);--> statement-breakpoint
CREATE INDEX `idx_rx_post` ON `reactions` (`post_id`);--> statement-breakpoint
CREATE INDEX `idx_rg_perm_scope` ON `role_grants` (`permission_key`,`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_tt_tag` ON `thread_tags` (`tag_id`);--> statement-breakpoint
CREATE INDEX `idx_threads_forum` ON `threads` (`forum_id`,`state`,`pin_level`,`last_posted_at`);--> statement-breakpoint
CREATE INDEX `idx_threads_author` ON `threads` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_threads_created` ON `threads` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_threads_featured` ON `threads` (`is_featured`);--> statement-breakpoint
CREATE INDEX `idx_threads_last` ON `threads` (`state`,`last_posted_at`);--> statement-breakpoint
CREATE INDEX `idx_ub_badge` ON `user_badges` (`badge_id`);--> statement-breakpoint
CREATE INDEX `idx_ur_user_kind` ON `user_restrictions` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_ur_user` ON `user_roles` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_users_state` ON `users` (`state`);--> statement-breakpoint
CREATE INDEX `idx_users_created` ON `users` (`created_at`);