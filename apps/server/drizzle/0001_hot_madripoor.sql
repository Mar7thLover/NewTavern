CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`width` integer,
	`height` integer,
	`source` text,
	`meta` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_sha256_idx` ON `assets` (`sha256`);--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`spec` text NOT NULL,
	`data` text NOT NULL,
	`book_id` text,
	`avatar_asset_id` text,
	`source_path` text,
	`original_hash` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `characters_name_idx` ON `characters` (`name`);--> statement-breakpoint
CREATE TABLE `chat_lorebooks` (
	`chat_id` text NOT NULL,
	`book_id` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `lorebooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_lorebooks_pair_idx` ON `chat_lorebooks` (`chat_id`,`book_id`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'roleplay' NOT NULL,
	`character_ids` text DEFAULT '[]' NOT NULL,
	`persona_id` text,
	`preset_id` text,
	`overrides` text,
	`root_node_id` text,
	`head_node_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`base_url` text NOT NULL,
	`keys_enc` text DEFAULT '' NOT NULL,
	`headers` text,
	`proxy` text,
	`quirks` text,
	`model_overrides` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entity_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`version` integer NOT NULL,
	`data` text NOT NULL,
	`author` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_versions_idx` ON `entity_versions` (`entity_type`,`entity_id`,`version`);--> statement-breakpoint
CREATE TABLE `generation_log` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`usage` text,
	`cost` integer,
	`latency_ms` integer,
	`layout_mode` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `generation_log_node_idx` ON `generation_log` (`node_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text,
	`result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lorebook_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`uid` integer,
	`keys` text DEFAULT '[]' NOT NULL,
	`secondary_keys` text DEFAULT '[]' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`comment` text,
	`constant` integer DEFAULT false NOT NULL,
	`selective` integer DEFAULT false NOT NULL,
	`selective_logic` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`depth` integer,
	`order` integer DEFAULT 100 NOT NULL,
	`probability` integer,
	`group` text,
	`group_override` integer,
	`group_weight` integer,
	`scan_depth` integer,
	`case_sensitive` integer,
	`match_whole_words` integer,
	`use_group_scoring` integer,
	`automation_id` text,
	`role` text,
	`disabled` integer DEFAULT false NOT NULL,
	`sticky` integer,
	`cooldown` integer,
	`delay` integer,
	`exclude_recursion` integer,
	`prevent_recursion` integer,
	`delay_until_recursion` integer,
	`ignore_budget` integer,
	`decorators` text,
	`extra` text,
	`display_index` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `lorebooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lorebook_entries_book_idx` ON `lorebook_entries` (`book_id`);--> statement-breakpoint
CREATE TABLE `lorebooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`settings` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`parent_id` text,
	`sibling_seq` integer DEFAULT 0 NOT NULL,
	`role` text NOT NULL,
	`name` text,
	`parts` text NOT NULL,
	`reasoning` text,
	`variables` text,
	`wi_state` text,
	`usage` text,
	`provider` text,
	`model` text,
	`is_hidden` integer DEFAULT false NOT NULL,
	`extra` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_nodes_chat_idx` ON `message_nodes` (`chat_id`);--> statement-breakpoint
CREATE INDEX `message_nodes_parent_idx` ON `message_nodes` (`parent_id`);--> statement-breakpoint
CREATE TABLE `model_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`models` text DEFAULT '[]' NOT NULL,
	`fetched_at` integer,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`avatar_asset_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`api_family` text,
	`data` text NOT NULL,
	`sampling` text,
	`layout_policy` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prompt_library` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`role` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `regex_scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`owner_id` text,
	`script_name` text NOT NULL,
	`find_regex` text NOT NULL,
	`replace_string` text DEFAULT '' NOT NULL,
	`placement` text DEFAULT '[]' NOT NULL,
	`direction` text DEFAULT 'both' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`run_on_edit` integer DEFAULT false NOT NULL,
	`min_depth` integer,
	`max_depth` integer,
	`trim_strings` text,
	`substitute_regex` integer,
	`extra` text,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `variable_events` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`owner_id` text DEFAULT '' NOT NULL,
	`node_id` text,
	`op` text NOT NULL,
	`path` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `variables` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`owner_id` text DEFAULT '' NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variables_scope_owner_key_idx` ON `variables` (`scope`,`owner_id`,`key`);