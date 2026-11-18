ALTER TABLE `admin_api_tokens` ADD `permission_profile` varchar(32) DEFAULT 'legacy_m20_read' NOT NULL;--> statement-breakpoint
ALTER TABLE `admin_api_tokens` ADD `permission_snapshot` json;