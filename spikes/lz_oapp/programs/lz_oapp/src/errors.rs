use anchor_lang::prelude::error_code;

#[error_code]
pub enum LzOAppError {
    InvalidMessageLength,
    InvalidMessageType,
    InvalidSeq,
    InvalidSourceChain,
    InvalidEndpoint,
    UnknownPeer,
    PositionMismatch,
    SeqOverflow,
}
