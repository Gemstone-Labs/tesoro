// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Minimal, IKinetiqStakingManager} from "./IRateSource.sol";

interface IOpenFor {
    function openPositionFor(address owner, uint256 lstAmount, uint8 horizonMonths) external payable returns (uint64);
    function messageEndpoint() external view returns (address);
}

/// @title StakeZap
/// @notice Opens a Position from the chain's plain coin: the coin is staked through the provider's own deposit
///         (never a DEX swap), the received LST is locked in the vault for the caller, and the LayerZero fee is
///         paid, all in one transaction. Any failure reverts the whole call, so the Player keeps their coin.
///
/// `msg.value` = `stakeAmount` (coin to stake) + the LayerZero fee (vault `quotePositionLocked()` plus headroom).
/// The endpoint refunds the unused fee to this contract; it is forwarded to the caller. The zap keeps no funds and
/// no state between calls.
abstract contract StakeZap {
    IOpenFor public immutable vault;
    IERC20Minimal public immutable lst;

    error ZeroStake();
    error StakedTooLittle(uint256 got, uint256 wanted);
    error RefundFailed();
    error NotRefund();

    constructor(address vault_, address lst_) {
        vault = IOpenFor(vault_);
        lst = IERC20Minimal(lst_);
    }

    /// @param stakeAmount coin to stake (the rest of `msg.value` is the cross-chain fee)
    /// @param minLst the least LST the Player accepts for it (quote from the rate, minus slippage)
    function openWithNative(uint256 stakeAmount, uint256 minLst, uint8 horizonMonths)
        external
        payable
        returns (uint64 id, uint256 lstAmount)
    {
        if (stakeAmount == 0) revert ZeroStake();
        uint256 before = address(this).balance - msg.value;
        uint256 lstBefore = lst.balanceOf(address(this));
        _stake(stakeAmount);
        lstAmount = lst.balanceOf(address(this)) - lstBefore;
        if (lstAmount < minLst || lstAmount == 0) revert StakedTooLittle(lstAmount, minLst);
        _approveVault(lstAmount);
        id = vault.openPositionFor{value: msg.value - stakeAmount}(msg.sender, lstAmount, horizonMonths);
        uint256 refund = address(this).balance - before;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev Stake `amount` of the coin and leave the LST in this contract.
    function _stake(uint256 amount) internal virtual;

    function _approveVault(uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(lst).call(abi.encodeWithSignature("approve(address,uint256)", address(vault), amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "approve failed");
    }

    /// @dev Only the LayerZero fee refund (sent by the endpoint, or the vault) may send coin here.
    receive() external payable {
        if (msg.sender != address(vault) && msg.sender != vault.messageEndpoint()) revert NotRefund();
    }
}

/// @notice ETH -> wstETH through Lido. Sending ETH to the wstETH contract runs `stETH.submit` and mints wstETH
///         (shares) to the sender (docs.lido.fi/contracts/wsteth, `receive()`); no approvals, no swap.
///         Lido's own stake limit and pause revert the call.
contract LidoZap is StakeZap {
    constructor(address vault_, address wstETH_) StakeZap(vault_, wstETH_) {}

    function _stake(uint256 amount) internal override {
        (bool ok,) = address(lst).call{value: amount}("");
        require(ok, "Lido stake failed");
    }
}

/// @notice HYPE -> kHYPE through Kinetiq's StakingManager `stake()` (kinetiq.xyz/docs/contracts-and-audits; kHYPE
///         StakingManager 0x393D0B87Ed38fc779FD9611144aE649BA6082109). kHYPE is minted at once, no queue.
///         Kinetiq refuses stakes under `minStakeAmount()` (5 HYPE on 2026-10-15): the whole call reverts.
contract KinetiqZap is StakeZap {
    IKinetiqStakingManager public immutable stakingManager;

    constructor(address vault_, address khype_, address stakingManager_) StakeZap(vault_, khype_) {
        stakingManager = IKinetiqStakingManager(stakingManager_);
    }

    function minStake() external view returns (uint256) {
        return stakingManager.minStakeAmount();
    }

    function _stake(uint256 amount) internal override {
        stakingManager.stake{value: amount}();
    }
}
