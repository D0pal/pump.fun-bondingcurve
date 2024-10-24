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
  PumpFunEventHandlers
} from "./src";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { AnchorProvider } from "@coral-xyz/anchor";
import { bondingCurveFilter } from "./src/filters";
import bs58 from "bs58";
import BigNumber from "bignumber.js";
import { getSPLBalance } from "./util";

dotenv.config();

const eventsWSS = process.env.EVENTS_WSS as string;
const eventsRPC = process.env.EVENTS_RPC as string;
const transactionWSS = process.env.TRANSACTION_WSS as string;
const transactionRPC = process.env.TRANSACTION_RPC as string;
const eventsConnection = new Connection(eventsRPC, { commitment:DEFAULT_COMMITMENT, wsEndpoint: eventsWSS});
const transactionConnection = new Connection(transactionRPC, { commitment: DEFAULT_COMMITMENT, wsEndpoint: transactionWSS });
const signerKeyPair = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY || ""));
const wallet = new NodeWallet(signerKeyPair);
const eventsProvider = new AnchorProvider(eventsConnection, wallet);
const transactionProvider = new AnchorProvider(transactionConnection, wallet);
const eventSdk = new PumpFunSDK(eventsProvider);
const transactionSdk = new PumpFunSDK(transactionProvider);
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
let eventId: number;

const main = async () => {
  if (!eventsWSS) {
    console.error("Please set EVENTS_WSS in .env file");
    return;
  }
  if (!eventsRPC) {
    console.error("Please set EVENTS_RPC in .env file");
    return;
  }
  if (!transactionWSS) {
    console.error("Please set TRANSACTION_WSS in .env file");
    return;
  }
  if (!transactionRPC) {
    console.error("Please set TRANSACTION_RPC in .env file");
    return;
  }

  const handleEvent = async (event: any) => {
    if (isProcessingToken || mintCache.has(event.mint.toString())) {
      return;
    }

    mintCache.add(event.mint.toString());
    isProcessingToken = true;

    if (eventListenerType === "createEvent") {
      // For "createEvent", bypass filters and proceed to buyTransaction
      console.log(`[${getCurrentDateTime()}] Buying mint: ${event.mint}`);
      eventSdk.removeEventListener(eventId);
      buyTransaction(event.mint);
    } else if (eventListenerType === "tradeEvent") {
      // For "tradeEvent", apply filtering logic
      console.log(`[${getCurrentDateTime()}] Checking mint: ${event.mint}`);
      const bondingCurvePercent = await eventSdk.getBondingCurvePercentage(event.mint);
      const checkResults = await Promise.all([bondingCurveFilter(bondingCurvePercent!)]);
      const allFiltersOk = checkResults.every((result: any) => result!.ok);
  
      if (allFiltersOk) {
        eventSdk.removeEventListener(eventId);
        buyTransaction(event.mint);
      } else {
        isProcessingToken = false;
        console.log(checkResults, event.mint.toString());
      }
    }
  };

  const validEvents: Array<keyof PumpFunEventHandlers> = ["createEvent", "tradeEvent"];
  if (eventListenerType && validEvents.includes(eventListenerType as keyof PumpFunEventHandlers)) {
    eventId = eventSdk.addEventListener(eventListenerType as keyof PumpFunEventHandlers, handleEvent);
  } else {
    console.error("Invalid or undefined event listener specified in .env file");
  }
};

// Buy transaction logic
const buyTransaction = async (mintAddress: PublicKey) => {
  const bondingCurveAccount = await eventSdk.getBondingCurveAccount(mintAddress);
  const expectedAmountOut = bondingCurveAccount?.getBuyPrice(BigInt(buyAmount));
  const slippage = calculateWithSlippageBuy(expectedAmountOut!, buySlippage);
  const buyResult = await transactionSdk.buy(
    signerKeyPair, 
    mintAddress, 
    BigInt(buyAmount), 
    slippage, 
    {
      unitLimit: computeUnitLimit,
      unitPrice: computeUnitPrice,
    }
  );
  const [splBalance] = await Promise.all([
    getSPLBalance(transactionSdk.connection, mintAddress, signerKeyPair.publicKey)
  ]);
  if (buyResult.success && splBalance) {
    console.log(`[${getCurrentDateTime()}] Bought token: ${mintAddress}`);
    const tokenBalance = new BigNumber(splBalance ?? 0);
    const tokenBalanceBigInt = BigInt(tokenBalance.multipliedBy(Math.pow(10, DEFAULT_DECIMALS)).toFixed());
    await checkPriceIntervals(mintAddress, tokenBalanceBigInt);
  } else {
    console.log("Buy failed.");
  }
};

// Check price at intervals
const checkPriceIntervals = async (mintAddress: PublicKey, tokenBalance: bigint) => {
  const tokensBuyPrice = await eventSdk.getTokensBuyPrice(tokenBalance, mintAddress);
  const tokensBuyPriceBN = new BigNumber(tokensBuyPrice!.toString());
  interval = setInterval(async () => {
    try {
      const tokensSellPrice = await eventSdk.getTokensSellPrice(tokenBalance, mintAddress);
      const tokensSellPriceBN = new BigNumber(tokensSellPrice!.toString());
      checkTakeProfitOrStopLoss(mintAddress, tokensBuyPriceBN, tokensSellPriceBN, tokenBalance);
    } catch (error) {
      console.error("Error during price check:", error);
      clearInterval(interval);
    }
  }, checkInterval);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', async (key) => {
    if (key.toString() === 's' && tokenBalance) {
      console.log('Executing manual sell transaction...');
      await sellTransaction(mintAddress, tokenBalance);
    }
    if (key.toString() === 'e') {
      clearInterval(interval);
      console.log(`[${getCurrentDateTime()}] Gracefully shutting down...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      process.exit(0);
    }
  });
};

// Check take-profit or stop-loss
const checkTakeProfitOrStopLoss = async (
  mintAddress: PublicKey,
  tokensBuyPriceBN: BigNumber,
  tokensSellPriceBN: BigNumber,
  tokenBalance: bigint
) => {
  const profitTarget = tokensBuyPriceBN.multipliedBy(1 + takeProfitPercentage / 100);
  const stopLossTarget = tokensBuyPriceBN.multipliedBy(1 - stopLossPercentage / 100);
  if (takeProfitPercentage && tokensSellPriceBN.isGreaterThanOrEqualTo(profitTarget)) {
    clearInterval(interval);
    console.log(`[${getCurrentDateTime()}] Take-profit triggered.`);
    console.log('Executing Take-profit triggered sell transaction...');
    await sellTransaction(mintAddress, tokenBalance);
  } else if (stopLossPercentage && tokensSellPriceBN.isLessThanOrEqualTo(stopLossTarget)) {
    clearInterval(interval);
    console.log(`[${getCurrentDateTime()}] Stop-loss triggered.`);
    console.log('Executing Stop-loss triggered sell transaction...');
    await sellTransaction(mintAddress, tokenBalance);
  } 
  if (tokensBuyPriceBN && tokensSellPriceBN) {
    const profitOrStopLossPercentage = tokensSellPriceBN.minus(tokensBuyPriceBN).dividedBy(tokensBuyPriceBN).multipliedBy(100).toNumber();
    const color = profitOrStopLossPercentage < 0 ? '\x1b[31m' : '\x1b[32m'; 
    const resetColor = '\x1b[0m'; 
    console.log(
      `[${getCurrentDateTime()}] Buy price (SOL): ${tokensBuyPriceBN}, Sell price (SOL): ${tokensSellPriceBN}, Profit/Loss: ${color}${profitOrStopLossPercentage}%${resetColor}`
    );
  } else {
    console.error("Price values not properly initialized.");
    clearInterval(interval);
  }
};

// Sell transaction logic
const sellTransaction = async (mintAddress: PublicKey, tokenBalance: bigint) => {
  const sellResult = await transactionSdk.sell(
    signerKeyPair, 
    mintAddress, 
    tokenBalance, 
    sellSlippage,
    {
      unitLimit: computeUnitLimit,
      unitPrice: computeUnitPrice,
    }
  );
  const [splBalance] = await Promise.all([
    getSPLBalance(transactionSdk.connection, mintAddress, signerKeyPair.publicKey)
  ]);
  if (sellResult.success && !splBalance) {
    console.log(`[${getCurrentDateTime()}] Sold token: ${mintAddress}`);
    clearInterval(interval);
    console.log(`[${getCurrentDateTime()}] Gracefully shutting down...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    process.exit(0);
  } else {
    console.log("Sell failed.");
  }
};

main();