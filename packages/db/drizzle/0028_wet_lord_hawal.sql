CREATE TABLE `csp_reports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`violated_directive` varchar(64) NOT NULL,
	`effective_directive` varchar(64),
	`blocked_uri` varchar(200),
	`document_uri` varchar(200),
	`source_file` varchar(200),
	`line_number` int unsigned,
	`disposition` varchar(16),
	`created_at` datetime NOT NULL,
	CONSTRAINT `csp_reports_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_csp_reports_time` ON `csp_reports` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_csp_reports_directive` ON `csp_reports` (`violated_directive`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_csp_reports_document` ON `csp_reports` (`document_uri`,`created_at`);