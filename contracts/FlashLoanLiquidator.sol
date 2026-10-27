// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FlashLoanLiquidator (v2)
 * @notice Aave v3 flash-loan liquidation executor with E-Mode awareness and
 *         dual DEX routing (Uniswap V2 + V3 via SwapRouter02).
 *
 * Flow (single atomic transaction):
 *   1. Borrow `debtToCover` of `debtAsset` via the Aave Pool flash loan.
 *   2. Repay the target user's debt via Pool.liquidationCall, receiving aTokens
 *      for the seized collateral (at the applicable liquidation bonus).
 *   3. Withdraw the underlying collateral from the aTokens.
 *   4. Swap collateral -> debt asset:
 *        - poolFee == 0     -> Uniswap V2 `swapExactTokensForTokens`
 *        - poolFee  > 0     -> Uniswap V3 via SwapRouter02 `exactInputSingle`
 *      Protected by `minCollateralOut` (amountOutMinimum) slippage guard.
 *   5. Pool pulls back the flash loan + premium. Whatever remains in the
 *      contract is profit, claimable by the owner via sweep functions.
 *
 * E-MODE NOTE
 *   The bot passes debtToCover computed with the correct close factor:
 *   50% normally, 100% when the user is in E-Mode and the collateral reserve
 *   belongs to the same category (Aave applies the category bonus there).
 *   This contract stays agnostic — it just executes the amount given.
 *
 * SECURITY NOTES
 *  - `executeOperation` is callable ONLY by the Aave Pool, and only for
 *    operations this contract itself initiated.
 *  - `liquidate` is callable ONLY by the owner (the keeper bot's wallet).
 *  - Slippage is enforced on-chain via `minCollateralOut` — never set it to 0.
 *  - This is a reference implementation: get it reviewed before mainnet funds.
 *
 * SCOPE NOTE
 *  - This contract implements PROTOCOL-SANCTIONED liquidations only. It is not
 *    and must not be used to build sandwich/front-running strategies: those
 *    profit by degrading real traders' execution and are considered toxic MEV.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IPool {
    function flashLoan(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params
    ) external;

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @notice Uniswap SwapRouter02 — handles V3 pools internally, no callbacks
///         required from the calling contract.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

contract FlashLoanLiquidator {
    // ── types ────────────────────────────────────────────────────────────────
    /// @notice Decoded flash-loan callback payload (order MUST match the
    ///         `abi.encode(...)` performed in `liquidate()`).
    struct OpParams {
        address collateralAsset;
        address debtAsset;
        address user;
        uint256 minCollateralOut;
        address aToken;
        address swapRouter;
        uint24 poolFee;
        uint256 deadline;
    }

    // ── storage ──────────────────────────────────────────────────────────────
    IPool public immutable POOL;
    address public owner;

    bool private locked;

    // ── errors ───────────────────────────────────────────────────────────────
    error NotOwner();
    error NotPool();
    error BadInitiator();
    error Reentrant();
    error DeadlineExpired();
    error SwapFailed();
    error BadFeeTier();

    // ── events ───────────────────────────────────────────────────────────────
    event Liquidated(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 debtCovered,
        uint256 collateralReceived,
        uint256 swapBackend,
        uint256 profitLeftInContract
    );
    event TokenSwept(address indexed token, address indexed to, uint256 amount);
    event EthSwept(address indexed to, uint256 amount);

    // ── modifiers ────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyPool() {
        if (msg.sender != address(POOL)) revert NotPool();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert Reentrant();
        locked = true;
        _;
        locked = false;
    }

    constructor(address pool) {
        POOL = IPool(pool);
        owner = msg.sender;
    }

    // ── entry point ──────────────────────────────────────────────────────────
    /**
     * @notice Kick off a flash-loan liquidation. Only the owner (keeper bot).
     * @param collateralAsset Token to seize (e.g. WETH).
     * @param debtAsset       Token owed by the user (this is what we flash-borrow).
     * @param user            The borrower to liquidate.
     * @param debtToCover     Debt amount to repay (close factor already applied).
     * @param minCollateralOut Slippage guard: minimum debt-asset units from the swap.
     * @param aToken          aToken of `collateralAsset` (received from liquidationCall).
     * @param swapRouter      Router to convert collateral (V2 router or SwapRouter02).
     * @param poolFee         0 => V2 swap; >0 => V3 pool fee tier (100/500/3000/10000).
     * @param deadline        Swap deadline (unix seconds).
     */
    function liquidate(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        uint256 minCollateralOut,
        address aToken,
        address swapRouter,
        uint24 poolFee,
        uint256 deadline
    ) external onlyOwner nonReentrant {
        if (poolFee != 0 && poolFee != 100 && poolFee != 500 && poolFee != 3000 && poolFee != 10000) {
            revert BadFeeTier();
        }
        bytes memory params = abi.encode(
            collateralAsset, debtAsset, user, minCollateralOut, aToken, swapRouter, poolFee, deadline
        );
        POOL.flashLoan(address(this), debtAsset, debtToCover, params);
    }

    // ── Aave flash-loan callback ─────────────────────────────────────────────
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external onlyPool {
        if (initiator != address(this)) revert BadInitiator();

        OpParams memory p = abi.decode(params, (OpParams));

        if (block.timestamp > p.deadline) revert DeadlineExpired();

        // 1. Allow the pool to pull the flash loan + premium once we return.
        IERC20(asset).approve(address(POOL), amount + premium);

        // 2. Repay the user's debt; seize aTokens (receiveAToken = true).
        POOL.liquidationCall(p.collateralAsset, p.debtAsset, p.user, amount, true);

        // 3. Convert the aTokens back to the underlying collateral.
        uint256 collateralReceived = _collectCollateral(p.collateralAsset, p.aToken);

        // 4. Swap collateral -> debt asset if needed (slippage-guarded).
        //    The pool then pulls `amount + premium` of the debt asset; if the
        //    swap output does not cover it the whole flash loan reverts.
        if (p.collateralAsset != p.debtAsset && collateralReceived > 0) {
            _swap(p, collateralReceived);
        }

        // 5. Pool pulls `amount + premium` from this contract automatically.

        emit Liquidated(
            p.user,
            p.collateralAsset,
            p.debtAsset,
            amount,
            collateralReceived,
            p.poolFee == 0 ? 2 : 3,
            IERC20(p.debtAsset).balanceOf(address(this))
        );
    }

    /// @notice Withdraw the aTokens received from liquidationCall and return
    ///         the resulting underlying-collateral balance of this contract.
    function _collectCollateral(address collateralAsset, address aToken) private returns (uint256) {
        uint256 aBal = IERC20(aToken).balanceOf(address(this));
        if (aBal > 0) {
            POOL.withdraw(collateralAsset, aBal, address(this));
        }
        return IERC20(collateralAsset).balanceOf(address(this));
    }

    /// @notice Swap the seized collateral into the debt asset via the route
    ///         chosen off-chain (V2 when poolFee == 0, V3 tier otherwise).
    function _swap(OpParams memory p, uint256 collateralAmount) private {
        IERC20(p.collateralAsset).approve(p.swapRouter, collateralAmount);
        uint256 balBefore = IERC20(p.debtAsset).balanceOf(address(this));

        if (p.poolFee == 0) {
            // ── Uniswap V2 path ──────────────────────────────────────────────
            address[] memory path = new address[](2);
            path[0] = p.collateralAsset;
            path[1] = p.debtAsset;
            IUniswapV2Router(p.swapRouter).swapExactTokensForTokens(
                collateralAmount, p.minCollateralOut, path, address(this), p.deadline
            );
        } else {
            // ── Uniswap V3 path via SwapRouter02 ─────────────────────────────
            ISwapRouter02(p.swapRouter).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: p.collateralAsset,
                    tokenOut: p.debtAsset,
                    fee: p.poolFee,
                    recipient: address(this),
                    amountIn: collateralAmount,
                    amountOutMinimum: p.minCollateralOut,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        if (IERC20(p.debtAsset).balanceOf(address(this)) < balBefore + p.minCollateralOut) {
            revert SwapFailed();
        }
        IERC20(p.collateralAsset).approve(p.swapRouter, 0); // reset allowance
    }

    // ── profit management ────────────────────────────────────────────────────
    /// @notice Withdraw any ERC20 balance (profit or stuck funds) to `to`.
    function sweepToken(address token, address to) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "nothing to sweep");
        IERC20(token).transfer(to, bal);
        emit TokenSwept(token, to, bal);
    }

    /// @notice Withdraw native ETH accidentally sent to this contract.
    function sweepEth(address payable to) external onlyOwner {
        uint256 bal = address(this).balance;
        require(bal > 0, "nothing to sweep");
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "eth sweep failed");
        emit EthSwept(to, bal);
    }

    /// @notice Transfer ownership to a new address.
    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    receive() external payable {}
}
