import {
  Commitment,
  ComputeBudgetProgram,
  Connection,
  Finality,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  VersionedTransactionResponse,
} from '@solana/web3.js';

import { bloxroutetx } from './bloxroutetx';
import { bloxrouteTip } from './tip';
import {
  PriorityFee,
  TransactionResult,
} from './types';
import { JitoTransactionExecutor } from './transactions/';
import dotenv from 'dotenv';
import bs58 from "bs58";

dotenv.config();

const BLOXROUTE_TIP = parseFloat(process.env.BLOXROUTE_TIP || '0');
const JITO_TIP = process.env.JITO_TIP || '';

export const DEFAULT_COMMITMENT: Commitment = "processed";
export const DEFAULT_FINALITY: Finality = "confirmed";

export const calculateWithSlippageBuy = (
  amount: bigint,
  basisPoints: bigint
) => {
  return amount + (amount * basisPoints) / 10000n;
};

export const calculateWithSlippageSell = (
  amount: bigint,
  basisPoints: bigint
) => {
  return amount - (amount * basisPoints) / 10000n;
};

export async function sendTx(
  connection: Connection,
  tx: Transaction,
  payer: Keypair,
  signers: Keypair[],
  priorityFees?: PriorityFee,
  commitment: Commitment = DEFAULT_COMMITMENT,
  finality: Finality = DEFAULT_FINALITY
): Promise<TransactionResult> {
  let newTx = new Transaction();

  if (priorityFees) {
    const priorityFeeData = await applyPriorityFees(
      connection, 
      tx, 
      payer, 
      priorityFees, 
      commitment
    );

    if (!priorityFeeData) {
      return {
        success: false,
        error: "Failed to fetch priority fee estimate",
      };
    }

    const { recommendedFee, customersCU } = priorityFeeData;

    newTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: customersCU }));
    newTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: recommendedFee }));
  }

  newTx.add(tx);

  let versionedTx = await buildVersionedTx(connection, payer.publicKey, newTx, commitment);
  versionedTx.sign(signers);

  try {
    const sig = await connection.sendTransaction(versionedTx, {
      skipPreflight: true,
      maxRetries: 0,
    });
    console.log("Transaction Signature:", `https://solscan.io/tx/${sig}`);

    let txResult = await getTxDetails(connection, sig, commitment, finality);
    if (!txResult) {
      return {
        success: false,
        error: "Transaction failed",
      };
    }

    return {
      success: true,
      signature: sig,
      results: txResult,
    };
  } catch (e) {
    handleTxError(e, connection);
    return {
      error: e,
      success: false,
    };
  }
}

async function applyPriorityFees(
  connection: Connection,
  tx: Transaction,
  payer: Keypair,
  priorityFees: PriorityFee,
  commitment: Commitment
): Promise<{ recommendedFee: number; customersCU: number } | null> {
  let simulateTx = new Transaction();

  simulateTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: priorityFees.unitLimit }));
  simulateTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFees.unitPrice }));
  simulateTx.add(tx);

  const testTransaction = await buildVersionedTx(connection, payer.publicKey, simulateTx, commitment);
  
  // Simulate transaction to get units consumed
  const rpcResponse = await connection.simulateTransaction(testTransaction, {
    replaceRecentBlockhash: true,
    sigVerify: false,
  });

  const unitsConsumed = rpcResponse?.value?.unitsConsumed;
  if (!unitsConsumed) return null;

  let customersCU = Math.ceil(unitsConsumed * 1.1);

  // Fetch recommended priority fee
  const response = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "getPriorityFeeEstimate",
      params: [
        {
          transaction: bs58.encode(testTransaction.serialize()),
          options: { recommended: true },
        },
      ],
    }),
  });

  const data = await response.json();
  const recommendedFee = data.result?.priorityFeeEstimate;
  if (!recommendedFee) return null;

  return { recommendedFee, customersCU };
}

function handleTxError(e: any, connection: Connection): void {
  if (e instanceof SendTransactionError) {
    e.getLogs(connection).then(logs => console.log(logs));
  } else {
    console.error(e);
  }
}

export async function sendBloxrouteTx(
  connection: Connection,
  tx: Transaction,
  payer: Keypair,
  signers: Keypair[],
  priorityFees?: PriorityFee,
  commitment: Commitment = DEFAULT_COMMITMENT,
  finality: Finality = DEFAULT_FINALITY
): Promise<TransactionResult> {
  let newTx = new Transaction();

  if (priorityFees) {
    const priorityFeeData = await applyPriorityFees(
      connection, 
      tx, 
      payer, 
      priorityFees, 
      commitment
    );

    if (!priorityFeeData) {
      return {
        success: false,
        error: "Failed to fetch priority fee estimate",
      };
    }

    const { recommendedFee, customersCU } = priorityFeeData;

    newTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: customersCU }));
    newTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: recommendedFee }));
  }
  
  newTx.add(tx);

  newTx.add(new TransactionInstruction({
    programId: new PublicKey("HQ2UUt18uJqKaQFJhgV9zaTdQxUZjNrsKFgoEDquBkcx"),
    data: Buffer.from("Powered by bloXroute Trader Api"),
    keys: []
  }))

  newTx.add(bloxrouteTip(payer.publicKey, BLOXROUTE_TIP));

  newTx.recentBlockhash = (await connection.getLatestBlockhash(DEFAULT_COMMITMENT)).blockhash;

  newTx.feePayer = payer.publicKey;

  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: newTx.recentBlockhash,
    instructions: newTx.instructions
  }).compileToV0Message();

  const versioned = new VersionedTransaction(messageV0)
  versioned.sign(signers)

  const tx64 = Buffer.from(versioned.serialize()).toString('base64')

  try {
    const sig = await bloxroutetx(tx64);
    console.log("Transaction Signature:", `https://solscan.io/tx/${sig}`);

    let txResult = await getTxDetails(connection, sig, commitment, finality);
    if (!txResult) {
      return {
        success: false,
        error: "Transaction failed",
      };
    }
    return {
      success: true,
      signature: sig,
      results: txResult,
    };
  } catch (e) {
    handleTxError(e, connection);
    return {
      error: e,
      success: false,
    };
  }
}

export async function sendJitoTx(
  connection: Connection,
  tx: Transaction,
  payer: Keypair,
  signers: Keypair[],
  priorityFees?: PriorityFee,
  commitment: Commitment = DEFAULT_COMMITMENT,
): Promise<TransactionResult> {
  let newTx = new Transaction();

  if (priorityFees) {
    const priorityFeeData = await applyPriorityFees(
      connection, 
      tx, 
      payer, 
      priorityFees, 
      commitment
    );

    if (!priorityFeeData) {
      return {
        success: false,
        error: "Failed to fetch priority fee estimate",
      };
    }

    const { recommendedFee, customersCU } = priorityFeeData;

    newTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: customersCU }));
    newTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: recommendedFee }));
  }

  newTx.add(tx);

  const blockhashInfo = await connection.getLatestBlockhash(DEFAULT_COMMITMENT);
  
  newTx.recentBlockhash = blockhashInfo.blockhash;
  
  newTx.feePayer = payer.publicKey;

  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: newTx.recentBlockhash,
    instructions: newTx.instructions
  }).compileToV0Message();

  const versioned = new VersionedTransaction(messageV0)
  versioned.sign(signers)

  try {
    const transactionExecutor = new JitoTransactionExecutor(JITO_TIP, connection);
    
    const sig =  await transactionExecutor.executeAndConfirm(versioned, payer, blockhashInfo);
    console.log("Transaction Signature:", `https://solscan.io/tx/${sig.signature}`);
    
    if (!sig.confirmed) {
      return {
        success: false,
        error: "Transaction failed",
      };
    }
    return {
      success: true,
      signature: sig.signature,
    };
  } catch (e) {
    handleTxError(e, connection);
    return {
      error: e,
      success: false,
    };
  }
};

export const buildVersionedTx = async (
  connection: Connection,
  payer: PublicKey,
  tx: Transaction,
  commitment: Commitment = DEFAULT_COMMITMENT
): Promise<VersionedTransaction> => {
  const blockHash = (await connection.getLatestBlockhash(commitment))
    .blockhash;

  let messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockHash,
    instructions: tx.instructions,
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
};

export const getTxDetails = async (
  connection: Connection,
  sig: string,
  commitment: Commitment = DEFAULT_COMMITMENT,
  finality: Finality = DEFAULT_FINALITY
): Promise<VersionedTransactionResponse | null> => {
  const latestBlockHash = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    {
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: sig,
    },
    commitment
  );

  return connection.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: finality,
  });
};

export function formatMarketCap(val: number){
  if(!val){
    return "0"
  }
  if(val < 1000){
    return val.toFixed(2)
  }
  return (val / 1000).toFixed(2) + "k"
}

export function formatPercent(val: string | number){
  return Number(val).toFixed(2) + "%"
}

export const getCurrentDateTime = () => {
  const now = new Date();

  // Extract date and time components
  const day = now.getDate().toString().padStart(2, '0');
  const month = now.toLocaleString('en-US', { month: 'short' }); // e.g., "Aug"
  const year = now.getFullYear().toString().slice(-2); // Last two digits of the year
  const hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');

  // Determine AM or PM
  const amPm = hours >= 12 ? 'PM' : 'AM';
  const formattedHours = hours % 12 || 12; // Convert to 12-hour format
  const formattedHoursString = formattedHours.toString().padStart(2, '0');

  return `${day} ${month} ${year} ${formattedHoursString}:${minutes}:${seconds} ${amPm}`;
};
