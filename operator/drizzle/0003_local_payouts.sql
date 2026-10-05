CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" varchar(16) NOT NULL,
	"complete_after" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "payouts_status_check" CHECK ("payouts"."status" IN ('processing', 'done')),
	CONSTRAINT "payouts_status_timestamps_check" CHECK (("payouts"."status" = 'processing' AND "payouts"."completed_at" IS NULL) OR ("payouts"."status" = 'done' AND "payouts"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "financial_operations" DROP CONSTRAINT "financial_operations_source_check";--> statement-breakpoint
ALTER TABLE "financial_operations" DROP CONSTRAINT "financial_operations_kind_source_check";--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" DROP CONSTRAINT "wallet_ledger_entries_source_check";--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_id_financial_operations_id_fk" FOREIGN KEY ("id") REFERENCES "public"."financial_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payouts_processing_complete_after_id_idx" ON "payouts" USING btree ("complete_after","id") WHERE "payouts"."status" = 'processing';--> statement-breakpoint
ALTER TABLE "financial_operations" ADD CONSTRAINT "financial_operations_source_check" CHECK ("financial_operations"."source" IN ('engine', 'reconciliation', 'test', 'payout'));--> statement-breakpoint
ALTER TABLE "financial_operations" ADD CONSTRAINT "financial_operations_kind_source_check" CHECK (("financial_operations"."source" = 'engine' AND "financial_operations"."kind" IN ('debit', 'credit')) OR ("financial_operations"."source" = 'reconciliation' AND "financial_operations"."kind" = 'credit') OR ("financial_operations"."source" = 'test' AND "financial_operations"."kind" = 'test_top_up') OR ("financial_operations"."source" = 'payout' AND "financial_operations"."kind" = 'debit'));--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_source_direction_check" CHECK ("wallet_ledger_entries"."source" <> 'payout' OR "wallet_ledger_entries"."direction" = 'debit');--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_source_check" CHECK ("wallet_ledger_entries"."source" IN ('engine', 'reconciliation', 'test', 'payout'));