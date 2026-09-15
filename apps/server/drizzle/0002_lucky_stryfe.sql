ALTER TABLE `personas` ADD `title` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `personas` ADD `description_position` text DEFAULT 'in_prompt' NOT NULL;--> statement-breakpoint
ALTER TABLE `personas` ADD `depth` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `personas` ADD `role` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `personas` ADD `lorebook_id` text REFERENCES lorebooks(id) ON DELETE SET NULL;