// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { OApp, Origin, MessagingFee, MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// Spike S2/S3: EVM half of the Tesoro cross-chain transport.
///
/// Wire format (identical to spikes/lz_oapp/programs/lz_oapp/src/msg_codec.rs, abi.encodePacked):
///   uint8 msgType | uint32 sourceChain | bytes32 positionId | uint64 seq | uint128 amount   (61 bytes)
///   msgType: 1 PositionLocked, 2 YieldAccrued (EVM -> Solana); 3 Unlock, 4 PayYield (Solana -> EVM)
/// `sourceChain` is always the LayerZero eid of the chain the Position lives on (this chain's eid).
contract TesoroSpikeOApp is OApp {
    uint8 public constant MSG_POSITION_LOCKED = 1;
    uint8 public constant MSG_YIELD_ACCRUED = 2;
    uint8 public constant MSG_UNLOCK = 3;
    uint8 public constant MSG_PAY_YIELD = 4;
    uint256 public constant MESSAGE_LEN = 61;

    struct Inbound {
        uint64 seq;
        uint8 msgType;
        uint128 amount;
    }

    /// Highest applied inbound (Solana -> here) seq per Position: replays and stale messages are no-ops.
    mapping(bytes32 positionId => Inbound) public lastIn;
    /// Last outbound (here -> Solana) seq per Position.
    mapping(bytes32 positionId => uint64) public lastOutSeq;

    event MessageSent(bytes32 indexed positionId, uint8 msgType, uint64 seq, uint128 amount, bytes32 guid);
    event MessageReceived(
        uint32 indexed srcEid, bytes32 indexed positionId, uint8 msgType, uint64 seq, uint128 amount, bool applied
    );

    error InvalidMessageLength();
    error InvalidMessageType();
    error InvalidSourceChain();
    error InvalidSeq();

    constructor(address endpoint, address delegate) OApp(endpoint, delegate) Ownable(delegate) { }

    /// Fee in native token for one Position message (all messages have the same length).
    function quoteSend(bytes calldata options) external view returns (MessagingFee memory) {
        return _quote(_solanaEid(), _encode(MSG_POSITION_LOCKED, bytes32(0), 1, 0), options, false);
    }

    /// EVM -> Solana. Spike-only access: owner. tesoro PositionVault will call this internally.
    function sendPosition(uint8 msgType, bytes32 positionId, uint128 amount, bytes calldata options)
        external
        payable
        onlyOwner
        returns (MessagingReceipt memory receipt)
    {
        if (msgType != MSG_POSITION_LOCKED && msgType != MSG_YIELD_ACCRUED) revert InvalidMessageType();
        uint64 seq = ++lastOutSeq[positionId];
        receipt = _lzSend(
            _solanaEid(),
            _encode(msgType, positionId, seq, amount),
            options,
            MessagingFee(msg.value, 0),
            payable(msg.sender)
        );
        emit MessageSent(positionId, msgType, seq, amount, receipt.guid);
    }

    /// Solana -> EVM. `OAppReceiver.lzReceive` has already checked msg.sender == endpoint and
    /// origin.sender == peers[origin.srcEid], so unknown peers never reach this function.
    function _lzReceive(Origin calldata origin, bytes32, bytes calldata message, address, bytes calldata)
        internal
        override
    {
        if (message.length != MESSAGE_LEN) revert InvalidMessageLength();
        uint8 msgType = uint8(message[0]);
        uint32 sourceChain = uint32(bytes4(message[1:5]));
        bytes32 positionId = bytes32(message[5:37]);
        uint64 seq = uint64(bytes8(message[37:45]));
        uint128 amount = uint128(bytes16(message[45:61]));

        if (msgType != MSG_UNLOCK && msgType != MSG_PAY_YIELD) revert InvalidMessageType();
        if (sourceChain != endpoint.eid()) revert InvalidSourceChain();
        if (seq == 0) revert InvalidSeq();

        Inbound storage last = lastIn[positionId];
        bool applied = seq > last.seq;
        if (applied) {
            last.seq = seq;
            last.msgType = msgType;
            last.amount = amount;
        }
        emit MessageReceived(origin.srcEid, positionId, msgType, seq, amount, applied);
    }

    function _encode(uint8 msgType, bytes32 positionId, uint64 seq, uint128 amount)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(msgType, endpoint.eid(), positionId, seq, amount);
    }

    /// Solana devnet eid on testnets (40168). Hard-coded for the spike: the only peer we send to.
    function _solanaEid() internal pure returns (uint32) {
        return 40168;
    }
}
