-- =====================================================================
-- qysub_next · 青翼字幕组新论坛库（MySQL 8.0, utf8mb4）
-- 设计原则：
--   1. 保留旧主键（uid/tid/pid/fid/aid/gid...），历史 URL 可精确 301
--   2. 每表带 raw JSON 列归档旧行，信息零丢失、可回滚
--   3. 时间统一为 DATETIME（北京时间墙面值，与旧站 FROM_UNIXTIME 显示一致）
--   4. 所有表幂等友好：UPSERT 主键即旧主键
-- =====================================================================

CREATE TABLE IF NOT EXISTS `groups` (
  `id`        MEDIUMINT UNSIGNED NOT NULL,
  `name`      VARCHAR(64)  NOT NULL,
  `type`      ENUM('default','member','system','special','vip') NOT NULL DEFAULT 'member',
  `points`    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '升级阈值',
  `image`     VARCHAR(64)  NOT NULL DEFAULT '',
  `raw`       JSON NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `users` (
  `id`            INT UNSIGNED NOT NULL COMMENT '旧 uid',
  `username`      VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL
                  COMMENT '区分大小写与假名（さくら≠サクラ）；EUC-JP 历史字节已无损转出',
  `email`         VARCHAR(128) NOT NULL DEFAULT '',
  `password_hash` VARCHAR(255) NULL COMMENT 'NULL=需密码重置（旧哈希不可迁移）',
  `group_id`      MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
  `gender`        TINYINT      NOT NULL DEFAULT 0,
  `location`      VARCHAR(100) NOT NULL DEFAULT '',
  `homepage`      VARCHAR(200) NOT NULL DEFAULT '',
  `signature_md`  TEXT NULL,
  `profile`       TEXT NULL,
  `post_count`    INT UNSIGNED NOT NULL DEFAULT 0,
  `digest_count`  INT UNSIGNED NOT NULL DEFAULT 0,
  `followers`     INT UNSIGNED NOT NULL DEFAULT 0,
  `fans`          INT UNSIGNED NOT NULL DEFAULT 0,
  `credits`       JSON NULL COMMENT '{"1":..,"8":..} 旧 credit1..8',
  `online_time`   INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '秒',
  `is_spam`       BOOLEAN      NOT NULL DEFAULT FALSE,
  `status`        SMALLINT     NOT NULL DEFAULT 0,
  `created_at`      DATETIME NULL,
  `last_visit_at`   DATETIME NULL,
  `last_post_at`    DATETIME NULL,
  `raw`           JSON NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_username` (`username`),
  KEY `idx_users_email` (`email`),
  KEY `idx_users_group` (`group_id`),
  KEY `idx_users_spam` (`is_spam`),
  KEY `idx_users_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `forums` (
  `id`          SMALLINT UNSIGNED NOT NULL COMMENT '旧 fid',
  `parent_id`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `type`        ENUM('category','forum','sub','sub2') NOT NULL DEFAULT 'forum',
  `name`        VARCHAR(255) NOT NULL,
  `name_style`  VARCHAR(255) NOT NULL DEFAULT '' COMMENT '从旧名称 HTML 中剥离的样式',
  `description` TEXT NULL,
  `summary`     TEXT NULL,
  `vieworder`   SMALLINT     NOT NULL DEFAULT 0,
  `is_show`     BOOLEAN      NOT NULL DEFAULT TRUE,
  `managers`    JSON NULL COMMENT '版主用户名数组',
  `icon`        VARCHAR(100) NOT NULL DEFAULT '',
  `logo`        VARCHAR(100) NOT NULL DEFAULT '',
  `thread_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `post_count`   INT UNSIGNED NOT NULL DEFAULT 0,
  `raw`         JSON NULL,
  PRIMARY KEY (`id`),
  KEY `idx_forums_parent` (`parent_id`),
  KEY `idx_forums_order` (`vieworder`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `threads` (
  `id`            INT UNSIGNED NOT NULL COMMENT '旧 tid',
  `forum_id`      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `author_id`     INT UNSIGNED NOT NULL DEFAULT 0,
  `title`         VARCHAR(140) NOT NULL DEFAULT '',
  `type_id`       INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '旧 topic_type（版块主题分类）',
  `digest`        TINYINT      NOT NULL DEFAULT 0,
  `topped`        TINYINT      NOT NULL DEFAULT 0,
  `special`       VARCHAR(20)  NOT NULL DEFAULT '',
  `reply_count`   INT UNSIGNED NOT NULL DEFAULT 0,
  `view_count`    INT UNSIGNED NOT NULL DEFAULT 0,
  `like_count`    INT UNSIGNED NOT NULL DEFAULT 0,
  `attach_count`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `content_md`    MEDIUMTEXT NULL COMMENT '首帖正文（Markdown）',
  `content_raw`   MEDIUMTEXT NULL COMMENT '首帖正文（原始 UBB）',
  `usehtml`       BOOLEAN NOT NULL DEFAULT FALSE,
  `tags`          VARCHAR(255) NOT NULL DEFAULT '',
  `is_spam`       BOOLEAN NOT NULL DEFAULT FALSE COMMENT '2018-11 广告空壳',
  `status`        TINYINT NOT NULL DEFAULT 0 COMMENT '0正常 1屏蔽/禁言 2盾牌',
  `created_at`        DATETIME NULL,
  `last_post_at`      DATETIME NULL,
  `last_post_user_id` INT UNSIGNED NOT NULL DEFAULT 0,
  `raw`           JSON NULL,
  PRIMARY KEY (`id`),
  KEY `idx_threads_forum` (`forum_id`, `is_spam`, `last_post_at`),
  KEY `idx_threads_author` (`author_id`),
  KEY `idx_threads_created` (`created_at`),
  KEY `idx_threads_digest` (`digest`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `posts` (
  `id`           INT UNSIGNED NOT NULL COMMENT '旧 pid（仅回帖；首帖正文在 threads 上）',
  `thread_id`    INT UNSIGNED NOT NULL,
  `author_id`    INT UNSIGNED NOT NULL DEFAULT 0,
  `floor`        INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '楼内序号，首条回帖=1',
  `reply_to_pid` INT UNSIGNED NULL,
  `subject`      VARCHAR(100) NOT NULL DEFAULT '',
  `content_md`   MEDIUMTEXT NULL,
  `content_raw`  MEDIUMTEXT NULL,
  `usehtml`      BOOLEAN NOT NULL DEFAULT FALSE,
  `like_count`   INT UNSIGNED NOT NULL DEFAULT 0,
  `status`       TINYINT NOT NULL DEFAULT 0 COMMENT '0正常 1屏蔽',
  `created_at`   DATETIME NULL,
  `modified_at`  DATETIME NULL,
  `raw`          JSON NULL,
  PRIMARY KEY (`id`),
  KEY `idx_posts_thread` (`thread_id`, `floor`),
  KEY `idx_posts_author` (`author_id`),
  KEY `idx_posts_reply` (`reply_to_pid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `attachments` (
  `id`          INT UNSIGNED NOT NULL COMMENT '旧 aid',
  `thread_id`   INT UNSIGNED NULL,
  `post_id`     INT UNSIGNED NULL COMMENT 'NULL=首帖附件',
  `uploader_id` INT UNSIGNED NOT NULL DEFAULT 0,
  `filename`    VARCHAR(255) NOT NULL DEFAULT '',
  `type`        VARCHAR(20)  NOT NULL DEFAULT '',
  `size_kb`     INT UNSIGNED NOT NULL DEFAULT 0,
  `path`        VARCHAR(255) NOT NULL DEFAULT '' COMMENT '相对 attachment/ 的路径，原样保留',
  `has_thumb`   BOOLEAN NOT NULL DEFAULT FALSE,
  `width`       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `height`      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `downloads`   INT UNSIGNED NOT NULL DEFAULT 0,
  `cost`        INT UNSIGNED NOT NULL DEFAULT 0,
  `special`     TINYINT      NOT NULL DEFAULT 0,
  `created_at`  DATETIME NULL,
  `raw`         JSON NULL,
  PRIMARY KEY (`id`),
  KEY `idx_att_thread` (`thread_id`),
  KEY `idx_att_post` (`post_id`),
  KEY `idx_att_uploader` (`uploader_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 表情：[s:N] → /emotion/{folder}/{icon}
CREATE TABLE IF NOT EXISTS `emoticon_categories` (
  `id`     INT UNSIGNED NOT NULL,
  `name`   VARCHAR(64) NOT NULL DEFAULT '',
  `folder` VARCHAR(32) NOT NULL DEFAULT '',
  `apps`   VARCHAR(64) NOT NULL DEFAULT '',
  `orderid` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_open` BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `emoticons` (
  `id`          INT UNSIGNED NOT NULL COMMENT '即旧 [s:N] 中的 N',
  `category_id` INT UNSIGNED NOT NULL DEFAULT 0,
  `folder`      VARCHAR(32) NOT NULL DEFAULT '',
  `icon`        VARCHAR(64) NOT NULL DEFAULT '',
  `is_used`     BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (`id`),
  KEY `idx_emo_cat` (`category_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `medals` (
  `id`              INT UNSIGNED NOT NULL COMMENT '旧 medal_id',
  `name`            VARCHAR(64) NOT NULL DEFAULT '',
  `path`            VARCHAR(64) NOT NULL DEFAULT '',
  `image`           VARCHAR(64) NOT NULL DEFAULT '',
  `icon`            VARCHAR(64) NOT NULL DEFAULT '',
  `description`     VARCHAR(255) NOT NULL DEFAULT '',
  `medal_type`      TINYINT NOT NULL DEFAULT 1,
  `receive_type`    TINYINT NOT NULL DEFAULT 1,
  `medal_gids`      VARCHAR(64) NOT NULL DEFAULT '',
  `award_type`      TINYINT NOT NULL DEFAULT 1,
  `award_condition` SMALLINT NOT NULL DEFAULT 0,
  `expired_days`    SMALLINT NOT NULL DEFAULT 0,
  `is_open`         BOOLEAN NOT NULL DEFAULT TRUE,
  `vieworder`       TINYINT NOT NULL DEFAULT 0,
  `raw`             JSON NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `user_medals` (
  `user_id`      INT UNSIGNED NOT NULL,
  `medal_id`     INT UNSIGNED NOT NULL,
  `counts`       INT UNSIGNED NOT NULL DEFAULT 0,
  `expired_time` DATETIME NULL,
  PRIMARY KEY (`user_id`, `medal_id`),
  KEY `idx_um_medal` (`medal_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `credit_logs` (
  `id`          INT UNSIGNED NOT NULL,
  `user_id`     INT UNSIGNED NOT NULL DEFAULT 0,
  `credit_type` VARCHAR(8)  NOT NULL DEFAULT '' COMMENT '对应 credits JSON 键',
  `delta`       INT         NOT NULL DEFAULT 0,
  `log_type`    VARCHAR(40) NOT NULL DEFAULT '',
  `description` VARCHAR(255) NOT NULL DEFAULT '',
  `created_at`  DATETIME NULL,
  PRIMARY KEY (`id`),
  KEY `idx_cl_user` (`user_id`, `credit_type`),
  KEY `idx_cl_time` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `polls` (
  `id`           INT UNSIGNED NOT NULL COMMENT '旧 poll_id',
  `thread_id`    INT UNSIGNED NULL,
  `voter_num`    INT UNSIGNED NOT NULL DEFAULT 0,
  `isafter_view` BOOLEAN NOT NULL DEFAULT FALSE,
  `isinclude_img` BOOLEAN NOT NULL DEFAULT FALSE,
  `option_limit` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `expired_time` DATETIME NULL,
  `creator_id`   INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`   DATETIME NULL,
  `raw`          JSON NULL,
  PRIMARY KEY (`id`),
  KEY `idx_polls_thread` (`thread_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `poll_options` (
  `id`        INT UNSIGNED NOT NULL,
  `poll_id`   INT UNSIGNED NOT NULL,
  `voted_num` INT UNSIGNED NOT NULL DEFAULT 0,
  `content`   VARCHAR(255) NOT NULL DEFAULT '',
  `image`     VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `idx_po_poll` (`poll_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `poll_voters` (
  `poll_id`    INT UNSIGNED NOT NULL,
  `option_id`  INT UNSIGNED NOT NULL,
  `user_id`    INT UNSIGNED NOT NULL,
  `created_at` DATETIME NULL,
  PRIMARY KEY (`poll_id`, `option_id`, `user_id`),
  KEY `idx_pv_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `private_messages` (
  `id`         INT UNSIGNED NOT NULL,
  `from_uid`   INT UNSIGNED NOT NULL DEFAULT 0,
  `to_uid`     INT UNSIGNED NOT NULL DEFAULT 0,
  `content`    MEDIUMTEXT NULL,
  `created_at` DATETIME NULL,
  `raw`        JSON NULL,
  PRIMARY KEY (`id`),
  KEY `idx_pm_from` (`from_uid`),
  KEY `idx_pm_to` (`to_uid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `message_dialogs` (
  `id`            INT UNSIGNED NOT NULL,
  `from_uid`      INT UNSIGNED NOT NULL DEFAULT 0,
  `to_uid`        INT UNSIGNED NOT NULL DEFAULT 0,
  `unread_count`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `message_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_message`  TEXT NULL,
  `modified_at`   DATETIME NULL,
  PRIMARY KEY (`id`),
  KEY `idx_md_to` (`to_uid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `migration_state` (
  `entity`      VARCHAR(64) NOT NULL,
  `rows_written` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `duration_ms`  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `finished_at`  DATETIME NULL,
  `note`        VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (`entity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
