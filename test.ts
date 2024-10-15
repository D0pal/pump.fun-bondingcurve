import dotenv from "dotenv";
import { 
  Connection, 
  Keypair, 
  LAMPORTS_PER_SOL, 
  PublicKey 
} from "@solana/web3.js";
import { 
  DEFAULT_COMMITMENT, 
  PumpFunSDK, 
  DEFAULT_DECIMALS, 
  calculateWithSlippageBuy, 
  calculateWithSlippageSell, 
  getCurrentDateTime, 
  BondingCurveAccount
} from "./src";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { AnchorProvider } from "@coral-xyz/anchor";
import { bondingCurveFilter } from "./src/filters";
import bs58 from "bs58";
import BigNumber from "bignumber.js";
import { getSPLBalance } from "./util";

dotenv.config();

const rpcEndpoint = process.env.RPC_ENDPOINT as string;
const connection = new Connection(rpcEndpoint);
const signerKeyPair = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY || ""));
const wallet = new NodeWallet(signerKeyPair);
const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
const sdk = new PumpFunSDK(provider);
const checkInterval = parseFloat(process.env.CHECK_INTERVAL || "0");
const buySlippage = BigInt(Math.floor(Number(process.env.BUY_SLIPPAGE || "0")));
const sellSlippage = BigInt(Math.floor(Number(process.env.SELL_SLIPPAGE || "0")));
const buyAmount = new BigNumber(process.env.BUY_AMOUNT!).multipliedBy(LAMPORTS_PER_SOL).toNumber();
const computeUnitLimit = parseFloat(process.env.COMPUTE_UNIT_LIMIT || "0");
const computeUnitPrice = parseFloat(process.env.COMPUTE_UNIT_PRICE || "0");
const eventListenerType = process.env.PUMP_FUN_EVENT_LISTENER;
const takeProfitPercentage = parseFloat(process.env.TAKE_PROFIT_PERCENTAGE || "0");
const stopLossPercentage = parseFloat(process.env.STOP_LOSS_PERCENTAGE || "0");

let mintCache = new Set<string>();
let interval: NodeJS.Timeout | undefined;
let isProcessingToken = false;
let eventId: number = 0;
let bondingCurveAccount: BondingCurveAccount | null;

const main = async () => {
  if (!rpcEndpoint) {
    console.error("Please set RPC_URL in .env file");
    return;
  }

  const handleEvent = async (event: any) => {
    if (isProcessingToken || mintCache.has(event.mint.toString())) {
      return;
    }

    mintCache.add(event.mint.toString());
    isProcessingToken = true;

    console.log(`[${getCurrentDateTime()}] Checking mint: ${event.mint}`);
   
    const bondingCurvePercent = await sdk.getBondingCurvePercentage(event.mint); 
    const checkResults = await Promise.all([bondingCurveFilter(bondingCurvePercent!)]);
    const allFiltersOk = checkResults.every((result: any) => result!.ok);

    if (allFiltersOk) {
      isProcessingToken = true;   
      bondingCurveAccount = await sdk.getBondingCurveAccount(event.mint);
      const getBuyPrice = bondingCurveAccount?.getBuyPrice(BigInt(buyAmount));
      const slippageBuy = calculateWithSlippageBuy(getBuyPrice!, buySlippage);
      buyTransaction(event.mint, slippageBuy); 
    } else {
      isProcessingToken = false;
      console.log(checkResults, event.mint.toString());
    } 
  };

  if (eventListenerType === "createEvent") {
    eventId = sdk.addEventListener("createEvent", handleEvent)
  } else if (eventListenerType === "tradeEvent") {
    eventId = sdk.addEventListener("tradeEvent", handleEvent)
  } else {
    console.error("Invalid event listener specified in .env file");
  }
};

// Buy transaction logic
const buyTransaction = async (mintAddress: PublicKey, slippage: bigint) => {
  const buyResult = await sdk.buy(signerKeyPair, mintAddress, BigInt(buyAmount), slippage, {
    unitLimit: computeUnitLimit,
    unitPrice: computeUnitPrice,
  });
  const [splBalance] = await Promise.all([
    getSPLBalance(sdk.connection, mintAddress, signerKeyPair.publicKey)
  ]);
  if (buyResult.success && splBalance) {
    isProcessingToken = true;
    console.log(`[${getCurrentDateTime()}] Bought token: ${mintAddress}`);
    const tokenBalance = new BigNumber(splBalance ?? 0);
    const tokenBalanceBigInt = BigInt(tokenBalance.multipliedBy(Math.pow(10, DEFAULT_DECIMALS)).toFixed());
    await checkPriceIntervals(sdk, mintAddress, tokenBalanceBigInt);
  } else {
    isProcessingToken = false;
    console.log("Buy failed.");
  }
};

// Check price at intervals
const checkPriceIntervals = async (sdk: PumpFunSDK, mintAddress: PublicKey, tokenBalance: bigint) => {
  isProcessingToken = true;
  const tokensBuyPrice = await sdk.getTokensBuyPrice(tokenBalance, mintAddress);
  const tokensBuyPriceBN = new BigNumber(tokensBuyPrice!.toString()).dividedBy(10**3);
  interval = setInterval(async () => {
    try {
      const tokensSellPrice = await sdk.getTokensSellPrice(tokenBalance, mintAddress);
      const tokensSellPriceBN = new BigNumber(tokensSellPrice!.toString()).dividedBy(10**3);
      
      const getSellPrice = bondingCurveAccount?.getSellPrice(tokenBalance, sellSlippage);
      const slippageSell = calculateWithSlippageSell(getSellPrice!, sellSlippage);

      checkTakeProfitOrStopLoss(sdk, mintAddress, tokensBuyPriceBN, tokensSellPriceBN, tokenBalance, slippageSell);
    } catch (error) {
      console.error("Error during price check:", error);
      clearInterval(interval);
    }
  }, checkInterval);
};

// Check take-profit or stop-loss
const checkTakeProfitOrStopLoss = async (
  sdk: PumpFunSDK,
  mintAddress: PublicKey,
  tokensBuyPriceBN: BigNumber,
  tokensSellPriceBN: BigNumber,
  tokenBalance: bigint,
  slippageSell:bigint
) => {
  const profitTarget = tokensBuyPriceBN.multipliedBy(1 + takeProfitPercentage / 100);
  const stopLossTarget = tokensBuyPriceBN.multipliedBy(1 - stopLossPercentage / 100);
  if (takeProfitPercentage && tokensSellPriceBN.isGreaterThanOrEqualTo(profitTarget)) {
    clearInterval(interval);
    isProcessingToken = true;
    console.log(`[${getCurrentDateTime()}] Take-profit triggered.`);
    await sellTransaction(sdk, mintAddress, tokenBalance, slippageSell);
  } else if (stopLossPercentage && tokensSellPriceBN.isLessThanOrEqualTo(stopLossTarget)) {
    clearInterval(interval);
    isProcessingToken = true;
    console.log(`[${getCurrentDateTime()}] Stop-loss triggered.`);
    await sellTransaction(sdk, mintAddress, tokenBalance, slippageSell);
  } 
  if (tokensBuyPriceBN && tokensSellPriceBN) {
    const priceChangePercentage = tokensSellPriceBN.minus(tokensBuyPriceBN).dividedBy(tokensBuyPriceBN).multipliedBy(100).toNumber();
    const color = priceChangePercentage < 0 ? '\x1b[31m' : '\x1b[32m'; 
    const resetColor = '\x1b[0m'; 
    console.log(
      `[${getCurrentDateTime()}] Buy price (SOL): ${tokensBuyPriceBN.toFixed()}, Sell price (SOL): ${tokensSellPriceBN.toFixed()}, Percentage change: ${color}${priceChangePercentage}%${resetColor}`
    );
  } else {
    console.error("Price values not properly initialized.");
    clearInterval(interval);
  }
};

// Sell transaction logic
const sellTransaction = async (sdk: PumpFunSDK, mintAddress: PublicKey, tokenBalance: bigint, slippage: bigint) => {
  if (tokenBalance) {
    const sellResult = await sdk.sell(signerKeyPair, mintAddress, tokenBalance, slippage);
    const [splBalance] = await Promise.all([
      getSPLBalance(sdk.connection, mintAddress, signerKeyPair.publicKey)
    ]);
    if (sellResult.success && !splBalance) {
      isProcessingToken = true;
      console.log(`[${getCurrentDateTime()}] Sold token: ${mintAddress}`);
      clearInterval(interval);
      sdk.removeEventListener(eventId);
      console.log(`[${getCurrentDateTime()}] Gracefully shutting down...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      process.exit(0);
    } else {
      isProcessingToken = false;
      console.log("Sell failed.");
    }
  }
};

main();
