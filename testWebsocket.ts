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
} from "./src";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { AnchorProvider } from "@coral-xyz/anchor";
import bs58 from "bs58";
import BigNumber from "bignumber.js";
import { getSPLBalance } from "./util";
import { TokenCreationListener } from "./src/listeners";

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
const buySlippage = BigInt(Math.floor(Number(process.env.BUY_SLIPPAGE || "0")));
const sellSlippage = BigInt(Math.floor(Number(process.env.SELL_SLIPPAGE || "0")));
const buyAmount = new BigNumber(process.env.BUY_AMOUNT!).multipliedBy(LAMPORTS_PER_SOL).toNumber();
const computeUnitLimit = parseFloat(process.env.COMPUTE_UNIT_LIMIT || "0");
const computeUnitPrice = parseFloat(process.env.COMPUTE_UNIT_PRICE || "0");

let interval: NodeJS.Timeout | undefined;

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

  // Create a new instance of the listener with the WebSocket URL and program ID
  const tokenListener = new TokenCreationListener(
    eventsWSS, 
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
  );

  // Listen for the 'tokenCreated' event
  tokenListener.on('tokenCreated', ({ signature, parsedData }) => {
    console.log(`New token created with signature: ${signature}`);
    console.log("Token Details:");
    console.log(parsedData);
    // Close the WebSocket
    tokenListener.closeConnection(); // Gracefully closes the WebSocket
    buyTransaction(new PublicKey(parsedData.mint));
  });

  // Listen for the 'error' event
  tokenListener.on('error', (error: Error) => {
    console.error('Error occurred:', error);
  });

  // Start listening for new tokens
  tokenListener.listenForNewTokens().catch(console.error);
};

// Buy transaction logic
const buyTransaction = async (mintAddress: PublicKey) => {
  /* const bondingCurveAccount = await eventSdk.getBondingCurveAccount(mintAddress);
  const expectedAmountOut = bondingCurveAccount?.getBuyPrice(BigInt(buyAmount));
  const slippage = calculateWithSlippageBuy(expectedAmountOut!, buySlippage); */
  const buyResult = await transactionSdk.buy(
    signerKeyPair, 
    mintAddress, 
    BigInt(buyAmount), 
    100n, 
    {
      unitLimit: computeUnitLimit,
      unitPrice: computeUnitPrice,
    }
  );
  const [splBalance] = await Promise.all([
    getSPLBalance(transactionSdk.connection, mintAddress, signerKeyPair.publicKey)
  ]);
  if (splBalance) {
    console.log(`[${getCurrentDateTime()}] Bought token: ${mintAddress}`);
    const tokenBalance = new BigNumber(splBalance ?? 0);
    const tokenBalanceBigInt = BigInt(tokenBalance.multipliedBy(Math.pow(10, DEFAULT_DECIMALS)).toFixed());
    await sellTransaction(mintAddress, tokenBalanceBigInt);
  } else {
    console.log("Buy failed.");
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
  if (!splBalance) {
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
