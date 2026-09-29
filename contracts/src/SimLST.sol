// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRateSource} from "./IRateSource.sol";

/// @title SimLST ("simETH")
/// @notice SIMULATED wstETH-like token for demos. Non-rebasing; its exchange rate against ETH
///         grows on an accelerated clock (default: 1 month of yield per 10 real minutes).
///         Not a real staking product. Withdrawals are paid from an admin-funded ETH reserve.
contract SimLST is IRateSource {
    string public constant name = "Simulated Staked ETH";
    string public constant symbol = "simETH";
    uint8 public constant decimals = 18;

    uint256 public constant RATE_SCALE = 1e18;
    uint256 public constant YEAR = 365 days;
    uint256 public constant BPS = 10_000;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public owner;
    bool public paused;

    // Rate = baseRate * (1 + apyBps * simElapsed / (BPS * YEAR)), simElapsed = realElapsed * speedup.
    uint256 public baseRate = RATE_SCALE;
    uint256 public baseTime;
    uint256 public apyBps = 500;
    uint256 public speedup = 4320; // 30 days per 600 s

    uint256 public faucetAmount = 10 ether;
    uint256 public faucetCooldown = 1 hours;
    mapping(address => uint256) public lastFaucet;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed account, uint256 ethIn, uint256 sharesOut);
    event Withdraw(address indexed account, uint256 sharesIn, uint256 ethOut);
    event ReserveFunded(address indexed from, uint256 amount);
    event RateParamsSet(uint256 baseRate, uint256 apyBps, uint256 speedup);
    event Paused(bool paused);
    event FaucetMint(address indexed to, uint256 amount);

    error NotOwner();
    error IsPaused();
    error ZeroAmount();
    error InsufficientReserve(uint256 needed, uint256 available);
    error InsufficientBalance();
    error InsufficientAllowance();
    error FaucetCooldown(uint256 availableAt);
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    constructor(address owner_) {
        owner = owner_;
        baseTime = block.timestamp;
    }

    // ---- rate ----

    function underlyingPerShare() public view returns (uint256) {
        uint256 simElapsed = (block.timestamp - baseTime) * speedup;
        return baseRate + (baseRate * apyBps * simElapsed) / (BPS * YEAR);
    }

    // ---- ETH <-> simETH ----

    function deposit() public payable whenNotPaused returns (uint256 shares) {
        if (msg.value == 0) revert ZeroAmount();
        shares = (msg.value * RATE_SCALE) / underlyingPerShare();
        if (shares == 0) revert ZeroAmount();
        _mint(msg.sender, shares);
        emit Deposit(msg.sender, msg.value, shares);
    }

    function withdraw(uint256 shares) external whenNotPaused returns (uint256 ethOut) {
        if (shares == 0) revert ZeroAmount();
        ethOut = (shares * underlyingPerShare()) / RATE_SCALE;
        if (ethOut > address(this).balance) revert InsufficientReserve(ethOut, address(this).balance);
        _burn(msg.sender, shares);
        (bool ok,) = msg.sender.call{value: ethOut}("");
        if (!ok) revert TransferFailed();
        emit Withdraw(msg.sender, shares, ethOut);
    }

    /// @notice Anyone can top up the ETH reserve that backs accrued yield.
    receive() external payable {
        emit ReserveFunded(msg.sender, msg.value);
    }

    // ---- faucet (unbacked, demo only) ----

    function faucet(address to) external whenNotPaused {
        uint256 availableAt = lastFaucet[to] + faucetCooldown;
        if (lastFaucet[to] != 0 && block.timestamp < availableAt) revert FaucetCooldown(availableAt);
        lastFaucet[to] = block.timestamp;
        _mint(to, faucetAmount);
        emit FaucetMint(to, faucetAmount);
    }

    // ---- admin ----

    function setRateParams(uint256 apyBps_, uint256 speedup_) external onlyOwner {
        baseRate = underlyingPerShare(); // checkpoint so past accrual is kept
        baseTime = block.timestamp;
        apyBps = apyBps_;
        speedup = speedup_;
        emit RateParamsSet(baseRate, apyBps_, speedup_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    function setFaucet(uint256 amount, uint256 cooldown) external onlyOwner {
        faucetAmount = amount;
        faucetCooldown = cooldown;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // ---- ERC20 ----

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }
}
