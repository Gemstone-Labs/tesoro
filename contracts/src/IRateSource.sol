// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Exchange rate of an LST share, in underlying units scaled by 1e18.
interface IRateSource {
    function underlyingPerShare() external view returns (uint256);
}

/// @notice Simulated LST whose yield is minted per Position (SimLST). Not implemented by real wstETH.
interface IYieldMinter {
    function mint(address to, uint256 amount) external;
    function apyBps() external view returns (uint256);
    function speedup() external view returns (uint256);
}

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IWstETH {
    function stEthPerToken() external view returns (uint256);
}

/// @notice Kinetiq StakingAccountant: `kHYPEToHYPE(x)` is the HYPE worth of x kHYPE (both 18 decimals).
interface IKinetiqAccountant {
    function kHYPEToHYPE(uint256 kHYPEAmount) external view returns (uint256);
}

/// @notice Outbound side of the messaging seam. LayerZero's endpoint (via an OApp) replaces this.
interface IMessageEndpoint {
    function send(bytes calldata payload) external;
}

/// @notice Lido's wstETH: sending ETH to it stakes through `stETH.submit` and mints wstETH to the sender.
interface IWstETHBalance {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Kinetiq StakingManager (kinetiq.xyz/docs/contracts-and-audits): `stake()` takes HYPE and mints kHYPE
///         to the caller at the StakingAccountant rate; stakes under `minStakeAmount()` revert.
interface IKinetiqStakingManager {
    function stake() external payable;
    function minStakeAmount() external view returns (uint256);
}
