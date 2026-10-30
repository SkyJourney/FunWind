ALTER TABLE `roles` ADD `is_public` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `email_verification_required` boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `users`
SET `email_verification_required` = true
WHERE `email_verified_at` IS NULL
  AND (
    EXISTS (
      SELECT 1
      FROM `site_settings`
      WHERE `key` = 'register.mode'
        AND JSON_UNQUOTE(JSON_EXTRACT(`value`, '$.mode')) = 'open'
    )
    OR EXISTS (
      SELECT 1
      FROM `site_settings`
      WHERE `key` = 'email.verification'
        AND JSON_UNQUOTE(JSON_EXTRACT(`value`, '$.mode')) = 'always'
    )
  );