// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMessageEndpoint} from "./IRateSource.sol";

interface IReceiver {
    function receiveMessage(bytes calldata payload) external;
}

/// @notice Test/demo stand-in for LayerZero: records outbound payloads, lets anyone deliver an inbound one.
///         NOT a security boundary; production replaces it with the LayerZero OApp endpoint path.
contract MockEndpoint is IMessageEndpoint {
    struct Sent {
        address sender;
        bytes payload;
    }

    Sent[] public outbox;

    event MessageSent(uint256 indexed index, address indexed sender, bytes payload);

    function send(bytes calldata payload) external {
        outbox.push(Sent(msg.sender, payload));
        emit MessageSent(outbox.length - 1, msg.sender, payload);
    }

    function outboxLength() external view returns (uint256) {
        return outbox.length;
    }

    function outboxPayload(uint256 i) external view returns (bytes memory) {
        return outbox[i].payload;
    }

    function deliver(address receiver, bytes calldata payload) external {
        IReceiver(receiver).receiveMessage(payload);
    }
}
