-- M8：站内搜索的 FULLTEXT 索引（MySQL 8 ngram 分词器，中日文 2-gram）。
-- drizzle DSL 不支持 FULLTEXT（indexes.d.ts 仅 unique/using/algorithm/lock），故手写本迁移。
-- 范围（docs/milestones/M8-interact-search.md §6）：threads.title + posts.body_md 两列各建索引；
-- body_md 是公开正文（门控隐藏内容只存 post_gates.hidden_md，天然不在索引中）。
CREATE FULLTEXT INDEX `ft_threads_title` ON `threads` (`title`) WITH PARSER ngram;--> statement-breakpoint
CREATE FULLTEXT INDEX `ft_posts_body` ON `posts` (`body_md`) WITH PARSER ngram;
