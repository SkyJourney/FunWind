CREATE TABLE `event_outbox` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`event_name` varchar(64) NOT NULL,
	`payload` json,
	`actor_id` int unsigned,
	`source` varchar(64),
	`created_at` datetime NOT NULL,
	`dispatched_at` datetime,
	`dispatch_error` json,
	CONSTRAINT `event_outbox_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_eo_pending` ON `event_outbox` (`dispatched_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_pl_user_channel_time` ON `point_ledger` (`user_id`,`channel`,`created_at`);--> statement-breakpoint
INSERT INTO `permissions` (`key`, `resource`, `level`, `description`) VALUES ('admin.points','admin',NULL,'积分规则配置与手工调整'),('admin.badges','admin',NULL,'荣誉徽章授予') AS new ON DUPLICATE KEY UPDATE `resource`=`new`.`resource`, `level`=`new`.`level`, `description`=`new`.`description`;--> statement-breakpoint
-- 基线授权对存量库的补授：仅当 admin 角色已有其他授权行（存量库，其基线不会再被 bootstrap 整批写入）时插入，
-- 且逐键判重（幂等）。全新库由 seedSystemData 按词汇表整批写入基线（本迁移此刻 role_grants 为空，天然跳过）。
INSERT INTO `role_grants` (`role_key`, `permission_key`, `scope_id`)
SELECT t.`role_key`, t.`permission_key`, 0 FROM (
  SELECT 'admin' AS `role_key`, 'admin.points' AS `permission_key`
  UNION ALL
  SELECT 'admin' AS `role_key`, 'admin.badges' AS `permission_key`
) AS t
WHERE EXISTS (
    SELECT 1 FROM `role_grants` g WHERE g.`role_key` = 'admin' AND g.`permission_key` <> t.`permission_key`
  )
  AND NOT EXISTS (
    SELECT 1 FROM `role_grants` g2
    WHERE g2.`role_key` = t.`role_key` AND g2.`permission_key` = t.`permission_key` AND g2.`scope_id` = 0
  );
