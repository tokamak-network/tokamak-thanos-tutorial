#! /usr/local/bin/node
require("dotenv").config();
const ethers = require("ethers");
const thanosSDK = require("@tokamak-network/thanos-sdk");
const fs = require("fs");

const NativeTokenABI = JSON.parse(fs.readFileSync("nativeTokenABI.json"));
const l1Rpc = process.env.L1_RPC;
const l2Rpc = process.env.L2_RPC;
const privateKey = process.env.PRIVATE_KEY;
const l1ChainId = process.env.L1_CHAIN_ID;
const l2ChainId = process.env.L2_CHAIN_ID;
const nativeToken = process.env.NATIVE_TOKEN;
const addressManager = process.env.ADDRESS_MANAGER;
const l1CrossDomainMessenger = process.env.L1_CROSS_DOMAIN_MESSENGER;
const l1StandardBridge = process.env.L1_STANDARD_BRIDGE;
const optimismPortal = process.env.OPTIMISM_PORTAL;
const l2OutputOracle = process.env.L2_OUTPUT_ORACLE;
const l1UsdcBridge = process.env.L1_USDC_BRIDGE_ADDRESS;
const disputeGameFactory = process.env.DISPUTE_GAME_FACTORY_ADDRESS;

const l1Contracts = {
  AddressManager: addressManager,
  L1CrossDomainMessenger: l1CrossDomainMessenger,
  L1StandardBridge: l1StandardBridge,
  StateCommitmentChain: "0x0000000000000000000000000000000000000000",
  CanonicalTransactionChain: "0x0000000000000000000000000000000000000000",
  BondManager: "0x0000000000000000000000000000000000000000",
  OptimismPortal: optimismPortal,
  OptimismPortal2: optimismPortal,
  L2OutputOracle: l2OutputOracle,
  L1UsdcBridge: l1UsdcBridge,
  DisputeGameFactory: disputeGameFactory,
};

let l1Signer, l2Signer;
const depositAmount = BigInt(1);
const withdrawAmount = BigInt(1);

// Global variable because we need them almost everywhere
let crossChainMessenger = null;
let nativeTokenOnL1Contract = null;

// Check if the private key has '0x' prefix
const addHexPrefix = (privateKey) => {
  if (privateKey.substring(0, 2) !== "0x") {
    privateKey = "0x" + privateKey;
  }
  return privateKey;
};

// Get the signers
const getSigners = async () => {
  const l1RpcProvider = new ethers.providers.JsonRpcProvider(l1Rpc);
  const l2RpcProvider = new ethers.providers.JsonRpcProvider(l2Rpc);
  const l1Wallet = new ethers.Wallet(addHexPrefix(privateKey), l1RpcProvider);
  const l2Wallet = new ethers.Wallet(
    addHexPrefix(privateKey),
    thanosSDK.asL2Provider(l2RpcProvider)
  );

  return [l1Wallet, l2Wallet];
};

// Only the part of the ABI we need to get the symbol
const setup = async () => {
  [l1Signer, l2Signer] = await getSigners();
  console.log(`L1 address: ${l1Signer.address}`);
  crossChainMessenger = new thanosSDK.CrossChainMessenger({
    bedrock: true,
    contracts: {
      l1: l1Contracts,
    },
    nativeTokenAddress: nativeToken,
    l1ChainId: l1ChainId,
    l2ChainId: l2ChainId,
    l1SignerOrProvider: l1Signer,
    l2SignerOrProvider: l2Signer,
  });

  nativeTokenOnL1Contract = new ethers.Contract(
    nativeToken,
    NativeTokenABI,
    l1Signer
  );
};

const reportBalances = async () => {
  const l1Balance = (
    await nativeTokenOnL1Contract.balanceOf(l1Signer.address)
  ).toString();
  const l2Balance = await crossChainMessenger.l2Signer.getBalance();
  console.log(
    `Native Token on L1:${l1Balance}. Native Token on L2: ${l2Balance}`
  );
};

const depositNativeToken = async () => {
  console.log(`Depositing TON...`);
  await reportBalances();
  const start = new Date();

  // Need the l2 address to know which bridge is responsible
  const allowanceResponse = await crossChainMessenger.approveNativeToken(
    depositAmount
  );
  await allowanceResponse.wait();
  console.log(
    `Approval native token transaction hash (on L1): ${allowanceResponse.hash}`
  );

  const response = await crossChainMessenger.bridgeNativeToken(depositAmount);
  console.log(`Deposit transaction hash (on L1): ${response.hash}`);
  await response.wait();

  console.log("Waiting for status to change to RELAYED");

  await crossChainMessenger.waitForMessageStatus(
    response.hash,
    thanosSDK.MessageStatus.RELAYED
  );

  await reportBalances();
  console.log(
    `Deposit native token took ${(new Date() - start) / 1000} seconds\n`
  );
};

// NOTE: should put the "fromBlockOrBlockHash" params in calling "waitForMessageStatus" function to prevent the timeout error when querying the logs from L1
const withdrawNativeToken = async () => {
  const l1RpcProvider = new ethers.providers.JsonRpcProvider(l1Rpc);
  const l1Block = await l1RpcProvider.getBlockNumber();
  const start = new Date();
  await reportBalances();

  const withdrawalResponse = await crossChainMessenger.withdrawNativeToken(
    withdrawAmount
  );
  const withdrawalTx = await withdrawalResponse.wait();

  console.log(`Withdraw transaction hash: ${withdrawalTx.transactionHash}`);

  console.log(`Wait the message status changed to READY_TO_PROVE`);

  await crossChainMessenger.waitForMessageStatus(
    withdrawalTx.transactionHash,
    thanosSDK.MessageStatus.READY_TO_PROVE,
    {
      fromBlockOrBlockHash: l1Block,
    }
  );

  console.log("Prove the message...");
  const proveTx = await crossChainMessenger.proveMessage(
    withdrawalTx.transactionHash
  );
  const proveReceipt = await proveTx.wait(3);
  console.log("Proved transaction hash: ", proveReceipt.transactionHash);

  const finalizeInterval = setInterval(async () => {
    const currentStatus = await crossChainMessenger.getMessageStatus(
      withdrawalTx
    );
    console.log("Current message status: ", currentStatus);
  }, 3000);

  try {
    await crossChainMessenger.waitForMessageStatus(
      withdrawalTx,
      thanosSDK.MessageStatus.READY_FOR_RELAY
    );
  } finally {
    clearInterval(finalizeInterval);
  }

  console.log(`Ready for relay, finalizing the message....`);
  const finalizeTxResponse = await crossChainMessenger.finalizeMessage(
    withdrawalTx.transactionHash
  );
  const finalizeTxReceipt = await finalizeTxResponse.wait();
  console.log("Finalized message tx", finalizeTxReceipt.transactionHash);

  console.log(`Waiting for status to change to RELAYED`);
  await crossChainMessenger.waitForMessageStatus(
    withdrawalResponse,
    thanosSDK.MessageStatus.RELAYED,
    {
      fromBlockOrBlockHash: l1Block,
    }
  );

  await reportBalances();
  console.log(
    `Withdraw native token took ${(new Date() - start) / 1000} seconds\n`
  );
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
