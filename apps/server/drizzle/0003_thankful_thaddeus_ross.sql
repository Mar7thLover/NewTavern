CREATE TABLE `character_sprites` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`label` text NOT NULL,
	`asset_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_sprites_char_label_idx` ON `character_sprites` (`character_id`,`label`);--> statement-breakpoint
CREATE TABLE `document_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text,
	`text` text DEFAULT '' NOT NULL,
	`author` text DEFAULT 'user' NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_idx` ON `document_versions` (`document_id`,`version`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text DEFAULT 'chapter' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`doc_order` integer DEFAULT 0 NOT NULL,
	`content` text,
	`text` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`summary_stale` integer DEFAULT false NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `writing_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `documents_project_idx` ON `documents` (`project_id`);--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`owner_id` text,
	`name` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`buttons` text DEFAULT '[]' NOT NULL,
	`data` text,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `writing_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`settings` text,
	`lorebook_ids` text DEFAULT '[]' NOT NULL,
	`outline` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `characters` ADD `edited_at` integer;