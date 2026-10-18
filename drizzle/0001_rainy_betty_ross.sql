CREATE TABLE `model_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`api_url` text NOT NULL,
	`model` text NOT NULL,
	`input_chars` integer NOT NULL,
	`key_ciphertext` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_profiles_user_idx` ON `model_profiles` (`user_id`);