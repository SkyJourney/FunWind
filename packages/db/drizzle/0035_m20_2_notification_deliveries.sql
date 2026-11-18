CREATE TABLE `notification_deliveries` (
	`outbox_id` bigint unsigned NOT NULL,
	`channel` varchar(16) NOT NULL,
	`scene` varchar(64) NOT NULL,
	`recipient_id` bigint unsigned NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'uncertain',
	`created_at` datetime NOT NULL,
	`finished_at` datetime,
	CONSTRAINT `notification_deliveries_outbox_id_channel_scene_recipient_id_pk` PRIMARY KEY(`outbox_id`,`channel`,`scene`,`recipient_id`),
	CONSTRAINT `ck_nd_status` CHECK(BINARY `notification_deliveries`.`status` IN ('uncertain', 'sent', 'failed'))
);
