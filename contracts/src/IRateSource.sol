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

/// @notice Outbound side of the messaging seam. LayerZero's endpoint (via an OApp) replaces this.
interface IMessageEndpoint {
    function send(bytes calldata payload) external;
}
