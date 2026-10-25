ALTER TABLE `notifications` ADD `open_group_key` varchar(96) GENERATED ALWAYS AS (IF(read_at IS NULL, group_key, NULL)) STORED;--> statement-breakpoint
-- 去重：同一 (user,type,group_key) 的多行未读只保留最新（唯一约束创建前的存量清理；行由历史竞态产生）
DELETE n1 FROM `notifications` n1
JOIN `notifications` n2
  ON n1.user_id = n2.user_id AND n1.type = n2.type
 AND n1.group_key = n2.group_key AND n1.read_at IS NULL AND n2.read_at IS NULL
 AND n1.id < n2.id;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `uq_nf_open_group` UNIQUE(`user_id`,`type`,`open_group_key`);