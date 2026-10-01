use anchor_lang::prelude::error_code;

#[error_code]
pub enum BridgeError {
    InvalidMessageLength,
    InvalidMessageType,
    InvalidSeq,
    InvalidSourceChain,
    InvalidEndpoint,
    UnknownPeer,
    PositionMismatch,
    SeqOverflow,
    InvalidPositionId,
    UnsupportedChain,
    AmountOverflow,
    NotOpened,
    AlreadyOpened,
    NothingToApply,
    NotLocked,
    NotUnlocked,
    UnlockAlreadySent,
    NothingToPay,
    NotBridgedPosition,
    NoEvmAddress,
    EvmAddressMismatch,
    InvalidEvmSignature,
    InvalidAccount,
    Unauthorized,
}
