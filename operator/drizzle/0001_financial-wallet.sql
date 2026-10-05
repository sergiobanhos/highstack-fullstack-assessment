CREATE TABLE "financial_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"source" varchar(24) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"engine_tx_id" varchar(255),
	"business_key" varchar(512),
	"bet_id" varchar(255),
	"round_id" varchar(255),
	"outcome" varchar(32) NOT NULL,
	"response_balance_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_operations_kind_check" CHECK ("financial_operations"."kind" IN ('debit', 'credit', 'test_top_up')),
	CONSTRAINT "financial_operations_source_check" CHECK ("financial_operations"."source" IN ('engine', 'reconciliation', 'test')),
	CONSTRAINT "financial_operations_kind_source_check" CHECK (("financial_operations"."source" = 'engine' AND "financial_operations"."kind" IN ('debit', 'credit')) OR ("financial_operations"."source" = 'reconciliation' AND "financial_operations"."kind" = 'credit') OR ("financial_operations"."source" = 'test' AND "financial_operations"."kind" = 'test_top_up')),
	CONSTRAINT "financial_operations_amount_cents_range" CHECK ("financial_operations"."amount_cents" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "financial_operations_outcome_check" CHECK ("financial_operations"."outcome" IN ('applied', 'insufficient_funds', 'balance_limit')),
	CONSTRAINT "financial_operations_response_balance_cents_range" CHECK ("financial_operations"."response_balance_cents" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"direction" varchar(8) NOT NULL,
	"source" varchar(24) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"balance_after_cents" bigint NOT NULL,
	"bet_id" varchar(255),
	"round_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledger_entries_direction_check" CHECK ("wallet_ledger_entries"."direction" IN ('debit', 'credit')),
	CONSTRAINT "wallet_ledger_entries_source_check" CHECK ("wallet_ledger_entries"."source" IN ('engine', 'reconciliation', 'test')),
	CONSTRAINT "wallet_ledger_entries_amount_cents_range" CHECK ("wallet_ledger_entries"."amount_cents" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "wallet_ledger_entries_balance_after_cents_range" CHECK ("wallet_ledger_entries"."balance_after_cents" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"player_id" uuid PRIMARY KEY NOT NULL,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_balance_cents_range" CHECK ("wallets"."balance_cents" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "financial_operations" ADD CONSTRAINT "financial_operations_player_id_wallets_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."wallets"("player_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_operation_id_financial_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."financial_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_player_id_wallets_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."wallets"("player_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_operations_engine_tx_id_unique" ON "financial_operations" USING btree ("engine_tx_id") WHERE "financial_operations"."engine_tx_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_operations_business_key_unique" ON "financial_operations" USING btree ("business_key") WHERE "financial_operations"."business_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "financial_operations_player_created_at_id_idx" ON "financial_operations" USING btree ("player_id","created_at","id");--> statement-breakpoint
CREATE INDEX "financial_operations_bet_id_idx" ON "financial_operations" USING btree ("bet_id") WHERE "financial_operations"."bet_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_ledger_entries_operation_id_unique" ON "wallet_ledger_entries" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "wallet_ledger_entries_player_created_at_id_idx" ON "wallet_ledger_entries" USING btree ("player_id","created_at","id");