#! /usr/local/bin/node
require("dotenv").config();
const ethers = require("ethers");
const thanosSDK = require("@tokamak-network/thanos-sdk");
const predeploys = require('@tokamak-network/core-utils')
const fs = require("fs");

const NativeTokenABI = JSON.parse(fs.readFileSync("nativeTokenABI.json"));
const l2NativeTokenAddr = process.env.L2_NATIVE_TOKEN;
const nativeTokenAddr = predeploys.LegacyERC20NativeToken
const privateKey = process.env.PRIVATE_KEY;

const l1RpcProvider = new ethers.providers.JsonRpcProvider(process.env.L1_RPC);
const l2RpcProvider = new ethers.providers.JsonRpcProvider(process.env.L2_RPC)
const l1Wallet = new ethers.Wallet(privateKey, l1RpcProvider);
const l2Wallet = new ethers.Wallet(privateKey, l2RpcProvider);
const zeroAddr = '0x'.padEnd(42, '0')
const depositAmount = BigInt(1)
const withdrawAmount = BigInt(1)

// Global variable because we need them almost everywhere
let crossChainMessenger;
let nativeTokenOnL1Contract;
let walletAddr;

// Only the part of the ABI we need to get the symbol
const setup = async () => {
  walletAddr = l1Wallet.address;
  crossChainMessenger = new thanosSDK.CrossChainMessenger({
    l1ChainId: process.env.L1_CHAIN_ID,
    l2ChainId: process.env.L2_CHAIN_ID,
    l1SignerOrProvider: l1Wallet,
    l2SignerOrProvider: l2Wallet,
    bedrock: true,
    nativeTokenAddress: process.env.L2_NATIVE_TOKEN
  });
  nativeTokenOnL1Contract = new ethers.Contract(l2NativeTokenAddr, NativeTokenABI, l1Wallet);
};

const reportBalances = async () => {
  const l1Balance = (await nativeTokenOnL1Contract.balanceOf(walletAddr)).toString();
  const l2Balance = (await crossChainMessenger.l2Signer.getBalance()) 
  console.log(`Native Token on L1:${l1Balance}. Native Token on L2: ${l2Balance}`);
};

const depositNativeToken = async () => {
  console.log(`Depositing TON...`)
  await reportBalances();
  const start = new Date();

  // Need the l2 address to know which bridge is responsible
  const allowanceResponse = await crossChainMessenger.approveNativeToken(
    l2NativeTokenAddr,
    nativeTokenAddr,
    depositAmount
  );
  await allowanceResponse.wait();
  console.log(`Approval native token transaction hash (on L1): ${allowanceResponse.hash}`)

  const response = await crossChainMessenger.bridgeNativeToken(depositAmount);
  console.log(`Deposit transaction hash (on L1): ${response.hash}`);
  await response.wait();

  console.log("Waiting for status to change to RELAYED");
  
  await crossChainMessenger.waitForMessageStatus(
    response.hash,
    thanosSDK.MessageStatus.RELAYED
  );

  await reportBalances();
  console.log(`Deposit native token took ${(new Date() - start) / 1000} seconds\n`);
};

// NOTE: should put the "fromBlockOrBlockHash" params in calling "waitForMessageStatus" function to prevent the timeout error when querying the logs from L1
const withdrawNativeToken = async () => {
  const l1Block = await l1RpcProvider.getBlockNumber()
  const start = new Date();
  await reportBalances()

  const withdrawalResponse = await crossChainMessenger.withdrawNativeToken(withdrawAmount)
  const withdrawalTx = await withdrawalResponse.wait()

  console.log(`Withdraw transaction hash: ${withdrawalTx.transactionHash}`)

  console.log(`Wait the message status changed to READY_TO_PROVE`)
  
  await crossChainMessenger.waitForMessageStatus(
    withdrawalTx.transactionHash,
    thanosSDK.MessageStatus.READY_TO_PROVE,
    {
      fromBlockOrBlockHash: l1Block
    }
  )

  console.log('Prove the message...')
  const proveTx = await crossChainMessenger.proveMessage(withdrawalTx.transactionHash)
  const proveReceipt = await proveTx.wait(3)
  console.log('Proved transaction hash: ', proveReceipt.transactionHash)

  const finalizeInterval = setInterval(async () => {
    const currentStatus = await crossChainMessenger.getMessageStatus(
      withdrawalTx
    )
    console.log('Current message status: ', currentStatus)
  }, 3000)

  try {
    await crossChainMessenger.waitForMessageStatus(
      withdrawalTx,
      thanosSDK.MessageStatus.READY_FOR_RELAY
    )
  } finally {
    clearInterval(finalizeInterval)
  }

  console.log(`Ready for relay, finalizing the message....`)
  const finalizeTxResponse = await crossChainMessenger.finalizeMessage(withdrawalTx.transactionHash)
  const finalizeTxReceipt = await finalizeTxResponse.wait()
  console.log('Finalized message tx', finalizeTxReceipt.transactionHash)

  console.log(`Waiting for status to change to RELAYED`)
  await crossChainMessenger.waitForMessageStatus(
    withdrawalResponse,
    thanosSDK.MessageStatus.RELAYED,
    {
      fromBlockOrBlockHash: l1Block 
    }
  )

  await reportBalances()
  console.log(`Withdraw native token took ${(new Date() - start) / 1000} seconds\n`);
};

const main = async () => {
  await setup();
  await depositNativeToken();
  await withdrawNativeToken();
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });