CREATE TABLE "game_bets" (
	"bet_id" varchar(255) PRIMARY KEY NOT NULL,
	"command_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"round_id" varchar(255) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"auto_cashout_hundredths" integer,
	"engine_status" varchar(16) NOT NULL,
	"multiplier_hundredths" bigint,
	"payout_cents" bigint,
	"settlement_status" varchar(24) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_bets_amount_cents_range_check" CHECK ("game_bets"."amount_cents" BETWEEN 1 AND 1000000000),
	CONSTRAINT "game_bets_auto_cashout_range_check" CHECK ("game_bets"."auto_cashout_hundredths" IS NULL OR "game_bets"."auto_cashout_hundredths" BETWEEN 101 AND 100000000),
	CONSTRAINT "game_bets_engine_status_check" CHECK ("game_bets"."engine_status" IN ('active', 'lost', 'cashed_out')),
	CONSTRAINT "game_bets_multiplier_hundredths_range_check" CHECK ("game_bets"."multiplier_hundredths" IS NULL OR "game_bets"."multiplier_hundredths" BETWEEN 100 AND 9007199254740991),
	CONSTRAINT "game_bets_payout_cents_range_check" CHECK ("game_bets"."payout_cents" IS NULL OR "game_bets"."payout_cents" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "game_bets_settlement_status_check" CHECK ("game_bets"."settlement_status" IN ('not_applicable', 'pending', 'confirmed', 'precision_incident')),
	CONSTRAINT "game_bets_settlement_consistency_check" CHECK (("game_bets"."engine_status" = 'cashed_out' AND "game_bets"."settlement_status" IN ('pending', 'confirmed', 'precision_incident')) OR ("game_bets"."engine_status" IN ('active', 'lost') AND "game_bets"."settlement_status" = 'not_applicable')),
	CONSTRAINT "game_bets_payout_requires_cashout_check" CHECK ("game_bets"."payout_cents" IS NULL OR "game_bets"."engine_status" = 'cashed_out')
);
--> statement-breakpoint
CREATE TABLE "game_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"command_type" varchar(16) NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" char(64) NOT NULL,
	"round_id" varchar(255),
	"bet_id" varchar(255),
	"amount_cents" bigint,
	"auto_cashout_hundredths" integer,
	"status" varchar(16) NOT NULL,
	"result_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "game_commands_type_check" CHECK ("game_commands"."command_type" IN ('bet', 'cashout')),
	CONSTRAINT "game_commands_status_check" CHECK ("game_commands"."status" IN ('pending', 'accepted', 'rejected', 'unknown')),
	CONSTRAINT "game_commands_request_hash_check" CHECK ("game_commands"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "game_commands_bet_fields_check" CHECK (("game_commands"."command_type" = 'bet' AND "game_commands"."round_id" IS NOT NULL AND "game_commands"."amount_cents" IS NOT NULL AND "game_commands"."amount_cents" BETWEEN 1 AND 1000000000) OR ("game_commands"."command_type" = 'cashout' AND "game_commands"."bet_id" IS NOT NULL AND "game_commands"."amount_cents" IS NULL AND "game_commands"."auto_cashout_hundredths" IS NULL)),
	CONSTRAINT "game_commands_auto_cashout_range_check" CHECK ("game_commands"."auto_cashout_hundredths" IS NULL OR "game_commands"."auto_cashout_hundredths" BETWEEN 101 AND 100000000),
	CONSTRAINT "game_commands_accepted_bet_id_check" CHECK ("game_commands"."command_type" <> 'bet' OR "game_commands"."status" <> 'accepted' OR "game_commands"."bet_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "game_bets" ADD CONSTRAINT "game_bets_command_id_game_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."game_commands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_bets_command_id_unique" ON "game_bets" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "game_bets_player_created_at_bet_id_idx" ON "game_bets" USING btree ("player_id","created_at","bet_id");--> statement-breakpoint
CREATE INDEX "game_bets_player_round_id_idx" ON "game_bets" USING btree ("player_id","round_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_commands_player_idempotency_key_unique" ON "game_commands" USING btree ("player_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "game_commands_player_round_active_bet_unique" ON "game_commands" USING btree ("player_id","round_id") WHERE "game_commands"."command_type" = 'bet' AND "game_commands"."status" IN ('pending', 'unknown', 'accepted');--> statement-breakpoint
CREATE UNIQUE INDEX "game_commands_pending_cashout_bet_unique" ON "game_commands" USING btree ("bet_id") WHERE "game_commands"."command_type" = 'cashout' AND "game_commands"."status" IN ('pending', 'unknown');--> statement-breakpoint
CREATE INDEX "game_commands_player_created_at_id_idx" ON "game_commands" USING btree ("player_id","created_at","id");--> statement-breakpoint
CREATE INDEX "game_commands_bet_id_idx" ON "game_commands" USING btree ("bet_id") WHERE "game_commands"."bet_id" IS NOT NULL;