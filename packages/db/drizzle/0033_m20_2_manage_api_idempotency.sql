CREATE TABLE `manage_api_idempotency` (
	`token_id` varchar(64) NOT NULL,
	`endpoint` varchar(64) NOT NULL,
	`key_hash` varchar(64) NOT NULL,
	`request_hash` varchar(64) NOT NULL,
	`response` json,
	`expires_at` datetime NOT NULL,
	CONSTRAINT `manage_api_idempotency_token_id_endpoint_key_hash_pk` PRIMARY KEY(`token_id`,`endpoint`,`key_hash`)
);
--> statement-breakpoint
CREATE INDEX `idx_mai_expires` ON `manage_api_idempotency` (`expires_at`);