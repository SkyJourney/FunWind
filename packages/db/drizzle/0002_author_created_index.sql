DROP INDEX `idx_posts_author` ON `posts`;--> statement-breakpoint
DROP INDEX `idx_threads_author` ON `threads`;--> statement-breakpoint
CREATE INDEX `idx_posts_author_created` ON `posts` (`author_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_threads_author_created` ON `threads` (`author_id`,`created_at`);