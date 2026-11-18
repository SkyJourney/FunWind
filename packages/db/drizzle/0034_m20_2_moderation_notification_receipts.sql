CREATE TABLE `notification_receipts` (
	`outbox_id` bigint unsigned NOT NULL,
	`type` varchar(64) NOT NULL,
	`user_id` int unsigned NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `notification_receipts_outbox_id_type_user_id_pk` PRIMARY KEY(`outbox_id`,`type`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `event_outbox` ADD `delivery_policy` varchar(32);