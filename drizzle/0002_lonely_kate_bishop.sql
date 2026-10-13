CREATE TABLE `content_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`json` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`order_id` text DEFAULT '' NOT NULL,
	`contact` text NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`admin_note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_label` text DEFAULT '月' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `service_intent` text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `activation_mode` text DEFAULT 'external' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `activation_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `activation_email` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `activation_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `category` text DEFAULT 'chatgpt' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `billing_label` text DEFAULT '月' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `original_price_cents` integer;--> statement-breakpoint
ALTER TABLE `products` ADD `activation_mode` text DEFAULT 'external' NOT NULL;