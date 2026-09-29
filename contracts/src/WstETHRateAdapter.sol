// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRateSource, IWstETH} from "./IRateSource.sol";

/// @notice Rate source for real wstETH: underlying is stETH, `stEthPerToken()` is the rate.
contract WstETHRateAdapter is IRateSource {
    IWstETH public immutable wstETH;

    constructor(address wstETH_) {
        wstETH = IWstETH(wstETH_);
    }

    function underlyingPerShare() external view returns (uint256) {
        return wstETH.stEthPerToken();
    }
}
