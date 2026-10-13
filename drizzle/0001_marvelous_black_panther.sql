CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`ciphertext` text NOT NULL,
	`hint` text NOT NULL,
	`order_id` text,
	`disabled` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cards_code_hash_unique` ON `cards` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `cards_order_id_unique` ON `cards` (`order_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `delivery_mode` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `delivery_instructions` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `delivery_mode` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `delivery_instructions` text DEFAULT '' NOT NULL;