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

import dotenv from 'dotenv';

dotenv.config();

const BLOXROUTE_TIP = parseFloat(process.env.BLOXROUTE_TIP || '0');

export const DEFAULT_COMMITMENT: Commitment = "confirmed";
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
  payer: PublicKey,
  signers: Keypair[],
  priorityFees?: PriorityFee,
  commitment: Commitment = DEFAULT_COMMITMENT,
  finality: Finality = DEFAULT_FINALITY
): Promise<TransactionResult> {
  let newTx = new Transaction();

  if (priorityFees) {
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
      units: priorityFees.unitLimit,
    });

    const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFees.unitPrice,
    });
    newTx.add(modifyComputeUnits);
    newTx.add(addPriorityFee);
  }

  newTx.add(tx);

  newTx.add(new TransactionInstruction({
    programId: new PublicKey("HQ2UUt18uJqKaQFJhgV9zaTdQxUZjNrsKFgoEDquBkcx"),
    data: Buffer.from("Powered by bloXroute Trader Api"),
    keys: []
  }))

  newTx.add(bloxrouteTip(payer, BLOXROUTE_TIP));

  newTx.recentBlockhash = (await connection.getLatestBlockhash("processed")).blockhash;

  newTx.feePayer = payer;

  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: newTx.recentBlockhash,
    instructions: newTx.instructions
  }).compileToV0Message();

  const versioned = new VersionedTransaction(messageV0)
  versioned.sign(signers)

  const tx64 = Buffer.from(versioned.serialize()).toString('base64')

  try {
    const sig = await bloxroutetx(tx64);
    console.log(sig);
    console.log("sig:", `https://solscan.io/tx/${sig}`);

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
    if (e instanceof SendTransactionError) {
      let ste = e as SendTransactionError;
      console.log(await ste.getLogs(connection));
    } else {
      console.error(e);
    }
    return {
      error: e,
      success: false,
    };
  }
}

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
