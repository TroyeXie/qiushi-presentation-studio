CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`error` text,
	`usage_json` text
);
--> statement-breakpoint
CREATE INDEX `jobs_user_date_idx` ON `jobs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_one_running_idx` ON `jobs` (`user_id`) WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`bytes` integer NOT NULL,
	`text_length` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `materials_user_idx` ON `materials` (`user_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`object_key` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_user_idx` ON `projects` (`user_id`);