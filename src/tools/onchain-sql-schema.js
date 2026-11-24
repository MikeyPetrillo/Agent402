// The table and column schema onchain-sql queries, kept here and served as
// it is: onchain-sql-schema answers from this file, with no upstream read.
// Table and column names with their types, checked against the query
// service's published schema on SCHEMA_UPDATED; a table or column the service
// adds is added here in the same change that relies on it
// (scripts/test-cdp-kit.js pins the shape). On Base Sepolia the same tables
// are read under the `base_sepolia.` prefix.
// Dependency-free.

export const SCHEMA_UPDATED = "2026-11-23";

// Table -> [column, type] pairs, in the service's column order.
const TABLES = {
  "base.blocks": [["block_number", "UInt64"], ["block_hash", "String"], ["parent_hash", "String"], ["timestamp", "DateTime"], ["miner", "String"], ["nonce", "UInt64"], ["sha3_uncles", "String"], ["transactions_root", "String"], ["state_root", "String"], ["receipts_root", "String"], ["logs_bloom", "String"], ["gas_limit", "UInt64"], ["gas_used", "UInt64"], ["base_fee_per_gas", "UInt64"], ["total_difficulty", "String"], ["size", "UInt64"], ["extra_data", "String"], ["mix_hash", "String"], ["withdrawals_root", "String"], ["parent_beacon_block_root", "String"], ["blob_gas_used", "UInt64"], ["excess_blob_gas", "UInt64"], ["transaction_count", "UInt64"], ["action", "Int8"]],
  "base.transactions": [["block_number", "UInt64"], ["block_hash", "String"], ["transaction_hash", "String"], ["transaction_index", "UInt64"], ["from_address", "String"], ["to_address", "String"], ["value", "String"], ["gas", "UInt64"], ["gas_price", "UInt64"], ["input", "String"], ["nonce", "UInt64"], ["type", "UInt64"], ["max_fee_per_gas", "UInt64"], ["max_priority_fee_per_gas", "UInt64"], ["chain_id", "UInt64"], ["v", "String"], ["r", "String"], ["s", "String"], ["is_system_tx", "Bool"], ["max_fee_per_blob_gas", "String"], ["blob_versioned_hashes", "Array(String)"], ["timestamp", "DateTime"], ["action", "Int8"]],
  "base.events": [["log_id", "String"], ["block_number", "UInt64"], ["block_hash", "FixedString(66)"], ["block_timestamp", "DateTime64(3, 'UTC')"], ["transaction_hash", "FixedString(66)"], ["transaction_to", "FixedString(42)"], ["transaction_from", "FixedString(42)"], ["log_index", "UInt32"], ["address", "FixedString(42)"], ["topics", "Array(FixedString(66))"], ["event_name", "LowCardinality(String)"], ["event_signature", "LowCardinality(String)"], ["parameters", "Map(String, Variant(Bool, Int256, String, UInt256))"], ["parameter_types", "Map(String, String)"], ["action", "Enum8('removed' = -1, 'added' = 1)"]],
  "base.encoded_logs": [["log_id", "String"], ["block_number", "UInt64"], ["block_hash", "FixedString(66)"], ["block_timestamp", "DateTime64(3, 'UTC')"], ["transaction_hash", "FixedString(66)"], ["transaction_to", "FixedString(42)"], ["transaction_from", "FixedString(42)"], ["log_index", "UInt32"], ["address", "FixedString(42)"], ["topics", "Array(FixedString(66))"], ["action", "Enum8('removed' = -1, 'added' = 1)"]],
  "base.decoded_user_operations": [["block_number", "UInt64"], ["block_timestamp", "DateTime64(3, 'UTC')"], ["transaction_hash", "FixedString(66)"], ["transaction_index", "UInt32"], ["user_op_hash", "FixedString(66)"], ["bundler", "FixedString(42)"], ["entry_point", "FixedString(42)"], ["entry_point_version", "LowCardinality(String)"], ["beneficiary", "FixedString(42)"], ["method_name", "Enum8('handleOps' = 1, 'handleAggregatedOps' = 2)"], ["method_signature", "LowCardinality(String)"], ["sender", "FixedString(42)"], ["user_op_data", "String"], ["actual_gas_cost", "String"], ["actual_gas_used", "String"], ["success", "Enum8('failure' = 0, 'success' = 1)"], ["builder_codes", "Array(LowCardinality(String))"], ["annotation_data", "String"], ["action", "Int8"]],
  "base.transaction_attributions": [["builder_code", "LowCardinality(String)"], ["block_timestamp", "DateTime64(3, 'UTC')"], ["block_number", "UInt64"], ["transaction_hash", "FixedString(66)"], ["transaction_index", "UInt32"], ["action", "Int8"], ["annotation_data", "String"], ["ingested_at", "DateTime64(3, 'UTC')"]],
  "solana.transfers": [["block_slot", "UInt64"], ["block_time", "DateTime64(3, 'UTC')"], ["tx_id", "String"], ["source", "String"], ["source_owner", "String"], ["destination", "String"], ["destination_owner", "String"], ["mint", "String"], ["amount", "UInt128"], ["outer_instruction_index", "UInt32"], ["inner_instruction_index", "Int32"], ["action", "Int8"], ["instruction_id", "String"]],
  "solana.instructions": [["block_slot", "UInt64"], ["block_hash", "String"], ["block_time", "DateTime64(3, 'UTC')"], ["tx_id", "String"], ["tx_index", "UInt32"], ["tx_signer", "String"], ["tx_success", "Bool"], ["outer_instruction_index", "UInt32"], ["inner_instruction_index", "Int32"], ["is_inner", "Bool"], ["stack_height", "UInt8"], ["executing_account", "LowCardinality(String)"], ["outer_executing_account", "LowCardinality(String)"], ["inner_executing_account", "LowCardinality(String)"], ["account_arguments", "Array(String)"], ["data", "String"], ["accounts", "Map(String, String)"], ["account_owners", "Map(String, String)"], ["account_mints", "Map(String, String)"], ["instruction_name", "LowCardinality(String)"], ["args", "Map(String, Variant(Bool, Int128, String, UInt128))"], ["arg_types", "Map(String, String)"], ["action", "Int8"], ["instruction_id", "String"]],
};

/** { tables: [{ name, columns: [{ name, type }] }] }: the shape the schema
 *  read answered in before it was kept here, so a caller reading
 *  schema.tables reads it unchanged. */
export const ONCHAIN_SQL_SCHEMA = Object.freeze({
  tables: Object.freeze(Object.entries(TABLES).map(([name, cols]) => Object.freeze({
    name,
    columns: Object.freeze(cols.map(([col, type]) => Object.freeze({ name: col, type }))),
  }))),
});
