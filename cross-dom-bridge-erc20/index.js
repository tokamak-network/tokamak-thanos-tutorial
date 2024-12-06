#! /usr/local/bin/node
require("dotenv").config();
const ethers = require("ethers");
const thanosSDK = require("@tokamak-network/thanos-sdk");
const fs = require("fs");

const erc20ABI = JSON.parse(fs.readFileSync("erc20.json"));
const privateKey = process.env.PRIVATE_KEY;
const l1Erc20Addr = process.env.L1_ERC20_ADDRESS
const l2Erc20Addr = process.env.L2_ERC20_ADDRESS
const nativeToken = process.env.NATIVE_TOKEN


const l1RpcProvider = new ethers.providers.JsonRpcProvider(process.env.L1_RPC);
const l2RpcProvider = new ethers.providers.JsonRpcProvider(process.env.L2_RPC)
const l1Wallet = new ethers.Wallet(privateKey, l1RpcProvider);
const l2Wallet = new ethers.Wallet(privateKey, l2RpcProvider);

const depositAmount = BigInt(1e6)
const withdrawAmount = BigInt(1e6)

// Global variable because we need them almost everywhere
let crossChainMessenger;
let l1ERC20, l2ERC20;
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
    nativeTokenAddress: nativeToken
  });
  l1ERC20 = new ethers.Contract(l1Erc20Addr, erc20ABI, l1Wallet);
  l2ERC20 = new ethers.Contract(l2Erc20Addr, erc20ABI, l2Wallet);
};

const reportBalances = async () => {
  const l1Balance = await l1ERC20.balanceOf(walletAddr);
  const l2Balance = await l2ERC20.balanceOf(walletAddr);
  console.log(`Token on L1:${l1Balance}     Token on L2:${l2Balance}`);
};

const depositERC20 = async () => {
  console.log(`Depositing ERC20...`)
  await reportBalances();
  const start = new Date();

  // Need the l2 address to know which bridge is responsible
  const allowanceResponse = await crossChainMessenger.approveERC20(
    l1Erc20Addr,
    l2Erc20Addr,
    depositAmount
  );
  await allowanceResponse.wait();
  console.log(`Approval ERC20 token transaction hash (on L1): ${allowanceResponse.hash}`)

  const response = await crossChainMessenger.bridgeERC20(
    l1Erc20Addr,
    l2Erc20Addr,
    depositAmount
  );
  console.log(`Deposit transaction hash (on L1): ${response.hash}`);
  await response.wait();

  console.log("Waiting for status to change to RELAYED");
  
  await crossChainMessenger.waitForMessageStatus(
    response.hash,
    thanosSDK.MessageStatus.RELAYED
  );

  await reportBalances();
  console.log(`Deposit ERC20 token took ${(new Date() - start) / 1000} seconds\n`);
};

const withdrawERC20 = async () => {
  const l1Block = await l1RpcProvider.getBlockNumber()
  const start = new Date();
  await reportBalances();

  // NOTE: If you want to withdraw USDC.e, you must approve to the L2USDCBridge contract with the approval function

  const withdrawalResponse = await crossChainMessenger.withdrawERC20(l1Erc20Addr, l2Erc20Addr, withdrawAmount)
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
      withdrawalTx,
      0,
      l1Block,
    )
    console.log('Current message status: ', currentStatus)
  }, 3000)

  try {
    await crossChainMessenger.waitForMessageStatus(
      withdrawalTx,
      thanosSDK.MessageStatus.READY_FOR_RELAY,
      {
        fromBlockOrBlockHash: l1Block
      }
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
  await depositERC20();
  await withdrawERC20();
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });