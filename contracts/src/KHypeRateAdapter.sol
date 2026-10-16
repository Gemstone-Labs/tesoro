// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRateSource, IKinetiqAccountant} from "./IRateSource.sol";

/// @notice Rate source for Kinetiq kHYPE on HyperEVM: underlying is HYPE, the rate is the StakingAccountant's
/// `kHYPEToHYPE(1e18)`. The rate rises with validator rewards and falls on a validator slashing
/// (`totalSlashing`); the vault computes yield from the rate it reads, so a fall lowers Accrued Yield with it.
contract KHypeRateAdapter is IRateSource {
    IKinetiqAccountant public immutable accountant;

    constructor(address accountant_) {
        accountant = IKinetiqAccountant(accountant_);
    }

    function underlyingPerShare() external view returns (uint256) {
        return accountant.kHYPEToHYPE(1e18);
    }
}
