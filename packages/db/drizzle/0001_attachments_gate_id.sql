ALTER TABLE `attachments` ADD `gate_id` int unsigned;--> statement-breakpoint
CREATE INDEX `idx_att_gate` ON `attachments` (`gate_id`);