use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    pub struct YesNoInput {
        pub resolved_side: u8,  // 0 = NO  1 = YES
        pub positions: [u8; 8], // encrypted side per bettor slot
        pub count: u32,         // actual bettors in this shard (≤ 8)
    }

    pub struct MultiOutcomeInput {
        pub resolved_outcome: u8, // winning outcome index 0-3
        pub positions: [u8; 8],   // encrypted outcome index per bettor slot
        pub count: u32,           // actual bettors in this shard (≤ 8)
    }

    pub struct AccuracyInput {
        pub resolved_value: u64, // oracle answer × 1000
        pub positions: [u64; 4], // encrypted predicted value × 1000 per slot
        pub count: u32,          // actual bettors in this shard (≤ 4)
    }

    // Named fields → callback accesses typed_output.winner_mask / typed_output.errors
    // (no more .field_0)

    pub struct YesNoOutput {
        pub winner_mask: [u8; 8],
        // 1 = winner, 0 = loser, 0 = unused slot (i >= count)
    }

    pub struct MultiOutcomeOutput {
        pub winner_mask: [u8; 8],
        // same layout as YesNo
    }

    pub struct AccuracyOutput {
        pub errors: [u64; 4],
        // |prediction_i - resolved_value| per slot, 0 for unused slots
        // emitted as 32 bytes (4 × u64 le) in ShardSettled.winner_mask
    }

    // ── CIRCUIT 1 — YES/NO
    //
    //  For each slot i:
    //    winner = (positions[i] == resolved_side)  — secret equality check
    //    mask   = (i < count)                      — secret count check
    //    result = winner_flag × mask               — zero out unused slots
    //
    //  if/else on secret conditions is Arcium's mux pattern — both branches
    //  always execute. Result is selected, not branched on.
    //
    //  Returns Enc<Shared, YesNoOutput>.
    //  Callback: let mask = typed_output.winner_mask;

    #[instruction]
    pub fn settle_yesno(input_ctxt: Enc<Shared, YesNoInput>) -> Enc<Shared, YesNoOutput> {
        let input = input_ctxt.to_arcis();
        let s = input.resolved_side;
        let n = input.count;

        // Each wN: secret u8 — 1 if this slot is a winner in-shard, else 0
        // (positions[i] == s) → secret bool → if/else mux → secret u8
        // (i < n)             → secret bool → if/else mux → secret u8
        let w0 =
            (if input.positions[0] == s { 1u8 } else { 0u8 }) * (if 0u32 < n { 1u8 } else { 0u8 });
        let w1 =
            (if input.positions[1] == s { 1u8 } else { 0u8 }) * (if 1u32 < n { 1u8 } else { 0u8 });
        let w2 =
            (if input.positions[2] == s { 1u8 } else { 0u8 }) * (if 2u32 < n { 1u8 } else { 0u8 });
        let w3 =
            (if input.positions[3] == s { 1u8 } else { 0u8 }) * (if 3u32 < n { 1u8 } else { 0u8 });
        let w4 =
            (if input.positions[4] == s { 1u8 } else { 0u8 }) * (if 4u32 < n { 1u8 } else { 0u8 });
        let w5 =
            (if input.positions[5] == s { 1u8 } else { 0u8 }) * (if 5u32 < n { 1u8 } else { 0u8 });
        let w6 =
            (if input.positions[6] == s { 1u8 } else { 0u8 }) * (if 6u32 < n { 1u8 } else { 0u8 });
        let w7 =
            (if input.positions[7] == s { 1u8 } else { 0u8 }) * (if 7u32 < n { 1u8 } else { 0u8 });

        input_ctxt.owner.from_arcis(YesNoOutput {
            winner_mask: [w0, w1, w2, w3, w4, w5, w6, w7],
        })
    }

    // CIRCUIT 2 — MULTI-OUTCOME
    //
    //  Identical logic to YesNo — just comparing outcome_index instead of side.
    //  Returns Enc<Shared, MultiOutcomeOutput>.
    //  Callback: let mask = typed_output.winner_mask;

    #[instruction]
    pub fn settle_multioutcome(
        input_ctxt: Enc<Shared, MultiOutcomeInput>,
    ) -> Enc<Shared, MultiOutcomeOutput> {
        let input = input_ctxt.to_arcis();
        let s = input.resolved_outcome;
        let n = input.count;

        let w0 =
            (if input.positions[0] == s { 1u8 } else { 0u8 }) * (if 0u32 < n { 1u8 } else { 0u8 });
        let w1 =
            (if input.positions[1] == s { 1u8 } else { 0u8 }) * (if 1u32 < n { 1u8 } else { 0u8 });
        let w2 =
            (if input.positions[2] == s { 1u8 } else { 0u8 }) * (if 2u32 < n { 1u8 } else { 0u8 });
        let w3 =
            (if input.positions[3] == s { 1u8 } else { 0u8 }) * (if 3u32 < n { 1u8 } else { 0u8 });
        let w4 =
            (if input.positions[4] == s { 1u8 } else { 0u8 }) * (if 4u32 < n { 1u8 } else { 0u8 });
        let w5 =
            (if input.positions[5] == s { 1u8 } else { 0u8 }) * (if 5u32 < n { 1u8 } else { 0u8 });
        let w6 =
            (if input.positions[6] == s { 1u8 } else { 0u8 }) * (if 6u32 < n { 1u8 } else { 0u8 });
        let w7 =
            (if input.positions[7] == s { 1u8 } else { 0u8 }) * (if 7u32 < n { 1u8 } else { 0u8 });

        input_ctxt.owner.from_arcis(MultiOutcomeOutput {
            winner_mask: [w0, w1, w2, w3, w4, w5, w6, w7],
        })
    }

    // CIRCUIT 3 — ACCURACY
    //
    //  For each slot i:
    //    diff = |positions[i] - resolved_value|
    //         = if positions[i] > resolved_value
    //             { positions[i] - resolved_value }
    //           else
    //             { resolved_value - positions[i] }
    //    error = diff × (i < count)   — zero unused slots
    //
    //  Returns Enc<Shared, AccuracyOutput>.
    //  Callback: let errors = typed_output.errors;
    //  Callback serialises errors as 4 × u64 le-bytes into ShardSettled.winner_mask.
    //  Backend decodes: for i in 0..4 { u64::from_le_bytes(bytes[i*8..i*8+8]) }

    #[instruction]
    pub fn settle_accuracy(input_ctxt: Enc<Shared, AccuracyInput>) -> Enc<Shared, AccuracyOutput> {
        let input = input_ctxt.to_arcis();
        let rv = input.resolved_value;
        let n = input.count;

        // slot 0
        let p0 = input.positions[0];
        let d0 = if p0 > rv { p0 - rv } else { rv - p0 };
        let e0 = d0 * (if 0u32 < n { 1u64 } else { 0u64 });

        // slot 1
        let p1 = input.positions[1];
        let d1 = if p1 > rv { p1 - rv } else { rv - p1 };
        let e1 = d1 * (if 1u32 < n { 1u64 } else { 0u64 });

        // slot 2
        let p2 = input.positions[2];
        let d2 = if p2 > rv { p2 - rv } else { rv - p2 };
        let e2 = d2 * (if 2u32 < n { 1u64 } else { 0u64 });

        // slot 3
        let p3 = input.positions[3];
        let d3 = if p3 > rv { p3 - rv } else { rv - p3 };
        let e3 = d3 * (if 3u32 < n { 1u64 } else { 0u64 });

        input_ctxt.owner.from_arcis(AccuracyOutput {
            errors: [e0, e1, e2, e3],
        })
    }
}
