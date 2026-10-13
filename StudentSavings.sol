// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title StudentSavings - individual ETH savings for an educational testnet DApp.
/// @notice No interest, lockup, administrator or third-party withdrawals.
contract StudentSavings {
    mapping(address => uint256) public balances;
    uint256 public totalLiabilities;
    bool private entered;

    event Deposited(address indexed account, uint256 amount, uint256 balance);
    event Withdrawn(address indexed account, uint256 amount, uint256 balance);
    error ZeroAmount();
    error InsufficientBalance();
    error TransferFailed();
    error ReentrantCall();
    error UseDeposit();

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    function deposit() external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        balances[msg.sender] += msg.value;
        totalLiabilities += msg.value;
        emit Deposited(msg.sender, msg.value, balances[msg.sender]);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > balances[msg.sender]) revert InsufficientBalance();
        balances[msg.sender] -= amount;
        totalLiabilities -= amount;
        (bool success,) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();
        emit Withdrawn(msg.sender, amount, balances[msg.sender]);
    }

    receive() external payable { revert UseDeposit(); }
    fallback() external payable { revert UseDeposit(); }
}
